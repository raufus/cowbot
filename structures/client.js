'use strict';

// Minimal shim so command files can `require('../../structures/client')`
// Many commands only import { bot } for JSDoc typing and don't actually use it at runtime.
// We export a lightweight class to satisfy the require without altering runtime behavior.

class bot {}

module.exports = { bot };
