import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import type {AddressInfo} from "node:net";
process.env.DB_FILE=":memory:";process.env.ATELIER_PASSWORD="test";
process.env.ATELIER_PUBLIC_URL="https://atelier.example.test";
const issuer="https://keycloak.example.test/realms/atelier";
process.env.ATELIER_OIDC_ISSUER=issuer;process.env.ATELIER_OIDC_CLIENT_ID="atelier";process.env.ATELIER_OIDC_CLIENT_SECRET="local-test-client-secret";
const {publicKey,privateKey}=generateKeyPairSync("rsa",{modulusLength:2048});
const jwk={...publicKey.export({format:"jwk"}),kid:"key-one",alg:"RS256",use:"sig"};
const grants=new Map<string,{nonce:string;challenge:string;sub:string;email:string;verified:boolean;badSignature?:boolean;issuer?:string;aud?:string;expired?:boolean}>();
const actualFetch=globalThis.fetch;
mock.method(globalThis,"fetch",async(input:Parameters<typeof fetch>[0],options?:RequestInit)=>{
  const url=String(input);
  if(!url.startsWith("https://keycloak.example.test/"))return actualFetch(input,options);
  if(url.includes(".well-known"))return Response.json({issuer,authorization_endpoint:issuer+"/protocol/openid-connect/auth",token_endpoint:issuer+"/protocol/openid-connect/token",jwks_uri:issuer+"/protocol/openid-connect/certs",response_types_supported:["code"],subject_types_supported:["public"],id_token_signing_alg_values_supported:["RS256"],token_endpoint_auth_methods_supported:["client_secret_basic"],code_challenge_methods_supported:["S256"]});
  if(url.endsWith("/certs"))return Response.json({keys:[jwk]});
  if(url.endsWith("/token")) {
    const params=new URLSearchParams(String(options?.body)),g=grants.get(params.get("code")!);assert.ok(g,"Unknown code");
    assert.equal(createHash("sha256").update(params.get("code_verifier")!).digest("base64url"),g.challenge);
    const head=Buffer.from(JSON.stringify({alg:"RS256",kid:"key-one",typ:"JWT"})).toString("base64url");
    const data=Buffer.from(JSON.stringify({iss:g.issuer??issuer,aud:g.aud??"atelier",sub:g.sub,nonce:g.nonce,email:g.email,email_verified:g.verified,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+(g.expired?-300:300)})).toString("base64url");
    const signature=g.badSignature?Buffer.alloc(256):sign("RSA-SHA256",Buffer.from(`${head}.${data}`),privateKey);
    return Response.json({access_token:"test-access-token",token_type:"Bearer",expires_in:300,id_token:`${head}.${data}.${signature.toString("base64url")}`});
  }
  throw new Error("Unexpected OIDC endpoint");
});
const d=await import("./db.ts"),{createApp}=await import("./app.ts"),{startSession}=await import("./session.ts"),{hashPassword}=await import("./auth.ts");
const user=d.createUser("tech@example.test",await hashPassword("a-local-password"));
const org=d.createOrg("Org",user.id);
const session=startSession(user.id),server=createApp().listen(0),base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(()=>{server.closeAllConnections();server.close();mock.restoreAll();});
type Flow={url:URL;cookie:string};
async function begin(link=true):Promise<Flow>{
  const r=await actualFetch(base+(link?"/api/me/sso/link":"/api/auth/sso/start?returnTo=https://evil.test"),{method:link?"POST":"GET",headers:link?{cookie:`atelier_session=${session}`,"content-type":"application/json"}:{},...(link?{body:"{}"}:{}),redirect:"manual"});
  assert.equal(r.status,link?200:303);
  const url=new URL(link?(await r.json() as {url:string}).url:r.headers.get("location")!);
  assert.equal(url.searchParams.get("code_challenge_method"),"S256");
  assert.ok(url.searchParams.get("state")&&url.searchParams.get("nonce"));
  const cookie=r.headers.get("set-cookie")!.split(";")[0];
  assert.ok(r.headers.get("set-cookie")!.includes("SameSite=Lax"));
  return {url,cookie};
}
let codeSerial=0;
async function finish(f:Flow,overrides:Partial<{sub:string;email:string;verified:boolean;badSignature:boolean;nonce:string;issuer:string;aud:string;expired:boolean}>={}){
  const code=String(++codeSerial);
  grants.set(code,{nonce:f.url.searchParams.get("nonce")!,challenge:f.url.searchParams.get("code_challenge")!,sub:"subject-one",email:user.email,verified:true,...overrides});
  return actualFetch(`${base}/api/auth/sso/callback?code=${code}&state=${f.url.searchParams.get("state")}`,{headers:{cookie:f.cookie},redirect:"manual"});
}
test("SSO adds a public login option without bypassing classic authentication",async()=>{
  assert.equal((await actualFetch(base+"/api/auth/sso")).status,200);
  const login=await actualFetch(base+"/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:user.email,password:"a-local-password"})});
  assert.equal(login.status,200);
  assert.equal((await actualFetch(base+"/api/me/sso/link",{method:"POST"})).status,401);
});
test("matching verified email does not automatically link an unknown identity",async()=>{
  const r=await finish(await begin(false));assert.equal(r.headers.get("location"),"/login?sso=link_required");
  assert.equal((d.db.prepare("select count(*) as n from sso_identities").get() as {n:number}).n,0);
});
test("account linking validates signed ID tokens and verified matching email",async()=>{
  for(const override of [{verified:false},{email:"someone-else@example.test"},{badSignature:true},{nonce:"wrong-nonce"},{issuer:"https://another-issuer.test"},{aud:"another-client"},{expired:true}]) {
    const r=await finish(await begin(),override);assert.equal(r.headers.get("location"),"/login?sso=failed");
  }
  const f=await begin(),r=await finish(f);
  assert.equal(r.headers.get("location"),"/");
  assert.ok(r.headers.get("set-cookie")!.includes("atelier_session="));
  assert.equal((d.db.prepare("select user_id from sso_identities").get() as {user_id:string}).user_id,user.id);
  const replay=await finish(f);assert.equal(replay.headers.get("location"),"/login?sso=failed");
});
test("SSO login keeps existing roles and rejects cross-browser state",async()=>{
  const f=await begin(false);
  const r=await finish(f);
  assert.equal(r.headers.get("location"),"/");
  assert.equal(d.roleOf(org,user.id),"owner");
  const other=await begin(false);other.cookie="__Host-atelier_oidc=wrong-browser";
  assert.equal((await finish(other)).headers.get("location"),"/login?sso=failed");
});
test("SSO association cannot finish after its original session is revoked",async()=>{
  const f=await begin();d.db.prepare("delete from sessions where token_hash=?").run(createHash("sha256").update(session).digest("hex"));
  assert.equal((await finish(f)).headers.get("location"),"/login?sso=failed");
});


test("unlinking requires the local password and leaves classic access available",async()=>{
  const live=startSession(user.id),cookie=`atelier_session=${live}`;
  for(const [password,status] of [["wrong",403],["a-local-password",200]] as const){
    const res=await actualFetch(base+"/api/me/sso",{method:"DELETE",headers:{cookie,"content-type":"application/json"},body:JSON.stringify({password})});assert.equal(res.status,status);
  }
  assert.equal((d.db.prepare("select count(*) as n from sso_identities").get() as {n:number}).n,0);
  const r=await actualFetch(base+"/api/me",{headers:{cookie}});assert.equal(r.status,200);
});
