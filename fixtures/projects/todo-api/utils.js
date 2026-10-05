const items = [];
exports.add = (t) => items.push({ t, done: false });
exports.list = () => items.slice();
