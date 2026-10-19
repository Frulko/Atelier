import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as oidc from "openid-client";
import { db, getUserById, normEmail, type User } from "./db.ts";
import { encrypt, decrypt } from "./vault.ts";
import { startSession, cookieHeader } from "./session.ts";
import { verifyPassword, MAX_PASSWORD } from "./auth.ts";
import { audit } from "./audit.ts";
import { body, HttpError, json } from "./http.ts";

db.exec(`create table if not exists sso_identities (
 issuer text not null, subject text not null, user_id text not null references users(id) on delete cascade,
 created_at integer not null, primary key(issuer,subject), unique(issuer,user_id)
); create table if not exists sso_flows (
 state_hash text primary key, browser_hash text not null, verifier blob not null, nonce text not null,
 user_id text references users(id) on delete cascade, session_hash text, return_to text not null, expires_at integer not null
);`);
const hash=(v:string)=>createHash("sha256").update(v).digest("hex");
const configured=()=>!!(process.env.ATELIER_OIDC_ISSUER&&process.env.ATELIER_OIDC_CLIENT_ID&&process.env.ATELIER_OIDC_CLIENT_SECRET&&process.env.ATELIER_PUBLIC_URL);
const issuer=()=>process.env.ATELIER_OIDC_ISSUER!;
const origin=()=>new URL(process.env.ATELIER_PUBLIC_URL!).origin;
const callback=()=>new URL("/api/auth/sso/callback",origin()).href;
const flowCookieName=()=>new URL(origin()).protocol==="https:"?"__Host-atelier_oidc":"atelier_oidc";
const flowCookie=(value:string,clear=false)=>`${flowCookieName()}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${clear?0:600}${origin().startsWith("https:")?"; Secure":""}`;
let cached:Promise<oidc.Configuration>|undefined;
async function configuration() {
  if(!configured())throw new HttpError(503,"Le SSO Keycloak n'est pas configuré.");
  if(!cached)cached=(async()=>{
    const server=new URL(issuer()),publicUrl=new URL(origin());
    if(server.protocol!=="https:" || server.username || server.password || server.search || server.hash || (publicUrl.protocol!=="https:" && publicUrl.hostname!=="localhost"))throw new Error("Configuration SSO refusée.");
    const cfg=await oidc.discovery(server,process.env.ATELIER_OIDC_CLIENT_ID!,{client_secret:process.env.ATELIER_OIDC_CLIENT_SECRET!,id_token_signed_response_alg:"RS256"},oidc.ClientSecretBasic(process.env.ATELIER_OIDC_CLIENT_SECRET!),{
      execute:[oidc.enableNonRepudiationChecks],
      [oidc.customFetch]:async(url,options)=>{
        const target=new URL(url);
        if(target.protocol!=="https:" || target.origin!==server.origin || target.username || target.password)throw new Error("Endpoint SSO refusé.");
        return fetch(url,{...options,redirect:"error",signal:AbortSignal.timeout(15000)} as RequestInit);
      },timeout:15,
    });
    for(const endpoint of [cfg.serverMetadata().authorization_endpoint,cfg.serverMetadata().token_endpoint,cfg.serverMetadata().jwks_uri]) {
      if(!endpoint || new URL(endpoint).origin!==server.origin || new URL(endpoint).protocol!=="https:")throw new Error("Endpoint SSO refusé.");
    }
    return cfg;
  })().catch(e=>{cached=undefined;throw e;});
  return cached;
}
function safeReturn(raw:string|null) {
  if(!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || raw.length>1000)return "/";
  try{return new URL(raw,origin()).origin===origin()?raw:"/";}catch{return "/";}
}
async function start(req:IncomingMessage,res:ServerResponse,returnTo:string|null,user?:User,session?:string) {
  const cfg=await configuration();
  db.prepare("delete from sso_flows where expires_at<?").run(Date.now());
  if((db.prepare("select count(*) as n from sso_flows").get() as {n:number}).n>=1000)throw new HttpError(429,"Trop de connexions SSO en attente.");
  const state=oidc.randomState(),browser=randomBytes(32).toString("base64url"),nonce=oidc.randomNonce(),verifier=oidc.randomPKCECodeVerifier();
  db.prepare("insert into sso_flows values (?,?,?,?,?,?,?,?)").run(hash(state),hash(browser),encrypt(verifier,"sso",hash(state)),nonce,user?.id??null,session?hash(session):null,safeReturn(returnTo),Date.now()+600_000);
  const url=oidc.buildAuthorizationUrl(cfg,{redirect_uri:callback(),scope:"openid profile email",response_type:"code",code_challenge:await oidc.calculatePKCECodeChallenge(verifier),code_challenge_method:"S256",state,nonce,...(user?{prompt:"login"}:{})});
  res.setHeader("set-cookie",flowCookie(browser));
  if(user)json(res,200,{url:url.href});else res.writeHead(303,{location:url.href}).end();
}
export async function ssoPublicApi(req:IncomingMessage,res:ServerResponse,url:URL,secure:boolean) {
  if(url.pathname==="/api/auth/sso" && req.method==="GET"){json(res,200,{enabled:configured(),label:"Keycloak"});return true;}
  if(!["/api/auth/sso/start","/api/auth/sso/callback"].includes(url.pathname))return false;
  if(req.method!=="GET")throw new HttpError(405,"Méthode refusée.");
  try {
    if(url.pathname.endsWith("/start")){await start(req,res,url.searchParams.get("returnTo"));return true;}
    if(!configured())throw new Error("SSO indisponible.");
    const state=url.searchParams.get("state"),browser=(req.headers.cookie??"").split(";").map(v=>v.trim()).find(v=>v.startsWith(`${flowCookieName()}=`))?.slice(flowCookieName().length+1);
    const flow=state?db.prepare("select * from sso_flows where state_hash=?").get(hash(state)) as {browser_hash:string;verifier:Buffer;nonce:string;user_id:string|null;session_hash:string|null;return_to:string;expires_at:number}|undefined:undefined;
    if(!flow || !browser || hash(browser)!==flow.browser_hash || flow.expires_at<=Date.now())throw new Error("Flux invalide.");
    db.prepare("delete from sso_flows where state_hash=?").run(hash(state!));
    const cfg=await configuration(),currentUrl=new URL(req.url!,origin());
    const tokens=await oidc.authorizationCodeGrant(cfg,currentUrl,{pkceCodeVerifier:decrypt(flow.verifier,"sso",hash(state!)),expectedState:state!,expectedNonce:flow.nonce,idTokenExpected:true});
    const claims=tokens.claims();
    if(!claims || typeof claims.sub!=="string" || !claims.sub || claims.sub.length>255)throw new Error("Identité invalide.");
    let userId:string;
    if(flow.user_id) {
      const user=getUserById(flow.user_id);
      if(!user || !db.prepare("select 1 from sessions where token_hash=? and user_id=? and expires_at>?").get(flow.session_hash!,flow.user_id,Date.now()) || claims.email_verified!==true || typeof claims.email!=="string" || normEmail(claims.email)!==user.email)throw new Error("Association refusée.");
      const linked=db.prepare("select user_id from sso_identities where issuer=? and subject=?").get(issuer(),claims.sub) as {user_id:string}|undefined;
      if(linked && linked.user_id!==user.id)throw new Error("Identité déjà associée.");
      db.prepare("insert into sso_identities (issuer,subject,user_id,created_at) values (?,?,?,?) on conflict(issuer,subject) do nothing").run(issuer(),claims.sub,user.id,Date.now());
      userId=user.id;
      audit({userId},"auth.sso_link");
    }else {
      const linked=db.prepare("select user_id from sso_identities where issuer=? and subject=?").get(issuer(),claims.sub) as {user_id:string}|undefined;
      if(!linked) {
        res.writeHead(303,{location:"/login?sso=link_required","set-cookie":flowCookie("",true)}).end();return true;
      }
      userId=linked.user_id;
    }
    const session=startSession(userId,Date.now(),{userAgent:String(req.headers["user-agent"]??""),ip:req.socket.remoteAddress});
    audit({userId},"auth.sso_login");
    res.writeHead(303,{location:flow.return_to,"set-cookie":[cookieHeader(session,secure),flowCookie("",true)]}).end();
  }catch(e){
    if(e instanceof HttpError && e.status===429)throw e;
    let cookie:string|undefined;try{if(configured())cookie=flowCookie("",true);}catch{}
    res.writeHead(303,{location:"/login?sso=failed",...(cookie?{"set-cookie":cookie}:{})}).end();
  }
  return true;
}
export async function ssoAccountApi(req:IncomingMessage,res:ServerResponse,url:URL,user:User,session:string) {
  if(url.pathname==="/api/me/sso" && req.method==="GET") {
    json(res,200,{enabled:configured(),linked:configured()&&!!db.prepare("select 1 from sso_identities where issuer=? and user_id=?").get(issuer(),user.id),label:"Keycloak"});return true;
  }
  if(url.pathname==="/api/me/sso/link" && req.method==="POST") {
    try{await start(req,res,"/",user,session);}catch{throw new HttpError(503,"SSO Keycloak indisponible. Vérifie la configuration du serveur.");}
    return true;
  }
  if(url.pathname==="/api/me/sso" && req.method==="DELETE") {
    const b=await body(req,3000);
    if(typeof b.password!=="string" || b.password.length>MAX_PASSWORD || !await verifyPassword(b.password,user.password_hash))throw new HttpError(403,"Mot de passe actuel requis.");
    db.prepare("delete from sso_identities where user_id=?").run(user.id);
    audit({userId:user.id},"auth.sso_unlink");json(res,200,{ok:true});return true;
  }
  return false;
}
