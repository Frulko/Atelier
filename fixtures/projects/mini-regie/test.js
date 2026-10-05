const assert = require("node:assert");
const { cout } = require("./cantine");
assert.strictEqual(cout(10, 12), 120);
assert.strictEqual(cout(30, 12, 20, 10), 20 * 12 + 10 * 10);
console.log("tests ok");
