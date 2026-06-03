const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gittensor-auth-'));
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
  if (request.startsWith('@/')) {
    return originalResolveFilename.call(
      this,
      path.join(repoRoot, 'src', request.slice(2)),
      parent,
      isMain,
      options,
    );
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

Module._load = function load(request, parent, isMain) {
  if (request === 'next/headers') {
    return {
      cookies: async () => ({ get: () => undefined, set: () => undefined }),
      headers: async () => ({ get: () => undefined }),
    };
  }
  if (request === 'next/server') {
    return {
      NextResponse: {
        json: (body, init) => ({ body, init }),
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.chdir(tempRoot);
process.env.SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';

const { demoteUser, countAdmins, RoleError } = require(path.join(repoRoot, 'src/lib/auth.ts'));
const { getDb } = require(path.join(repoRoot, 'src/lib/db.ts'));

const db = getDb();
const now = new Date().toISOString();
const insertUser = db.prepare(
  `INSERT INTO users (
     github_id, github_login, avatar_url, status, is_admin,
     created_at, last_login_at, approved_at, approved_by_id
   ) VALUES (?, ?, NULL, 'approved', ?, ?, ?, ?, NULL)`,
);

insertUser.run('1', 'admin-a', 1, now, now, now);
insertUser.run('2', 'admin-b', 1, now, now, now);

const results = [1, 2].map((id) => {
  try {
    return { ok: true, user: demoteUser(id, 999) };
  } catch (error) {
    return { ok: false, error };
  }
});

assert.equal(countAdmins(), 1, 'exactly one admin must remain after competing demotions');
assert.equal(results.filter((result) => result.ok).length, 1, 'one demotion should succeed');

const failures = results.filter((result) => !result.ok);
assert.equal(failures.length, 1, 'one demotion should fail');
assert.ok(failures[0].error instanceof RoleError, 'failure should be a RoleError');
assert.equal(failures[0].error.code, 'last_admin', 'failure should reject the last admin demotion');

console.log('demoteUser last-admin guard verified');
