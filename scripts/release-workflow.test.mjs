import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const workflow = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const require = createRequire(import.meta.url);
const sourceSha = 'a'.repeat(40);
const draft = { id: 123, draft: true, tag_name: 'v1.3.1', target_commitish: sourceSha };

function stepScript(name) {
  const index = workflow.indexOf(`- name: ${name}\n`);
  assert.ok(index >= 0, `Missing step ${name}`);
  const section = workflow.slice(index);
  const lines = section.slice(section.indexOf('          script: |\n') + '          script: |\n'.length).split('\n');
  const body = [];
  for (const line of lines) {
    if (line && !line.startsWith('            ')) break;
    body.push(line.slice(12));
  }
  return new AsyncFunction('require', 'github', 'context', 'core', body.join('\n'));
}

async function withEnvironment(run) {
  const values = { GITHUB_WORKSPACE: root, RELEASE_TAG: draft.tag_name, SOURCE_SHA: sourceSha, RELEASE_ID: String(draft.id) };
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await run(); }
  finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('prepare reuses the exact draft and checks the tag source when manually dispatched from a newer master', async () => {
  await withEnvironment(async () => {
    const updates = [], outputs = {};
    const github = {
      paginate: async () => [draft],
      rest: {
        repos: {
          listReleases() {},
          getLatestRelease: async () => { throw Object.assign(Error('No prior manifest'), { status: 404 }); },
          updateRelease: async fields => { updates.push(fields); return { data: { ...draft, html_url: 'https://example.test/draft' } }; },
          createRelease: async () => { throw Error('Must not create another draft'); },
        },
        checks: { listForRef: async fields => {
          assert.equal(fields.ref, sourceSha);
          return { data: { check_runs: [{ name: 'Static checks', app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success' }] } };
        } },
      },
    };
    const core = { setOutput: (key, value) => { outputs[key] = value; }, summary: { addLink() { return this; }, async write() {} } };
    await stepScript('Require successful master checks and prepare one draft')(require, github, { repo: { owner: 'test', repo: 'test' }, sha: 'b'.repeat(40) }, core);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].release_id, draft.id);
    // This fallback is ignored for the existing tag and must not resend its
    // older workflow commit into GitHub's workflows-write permission guard.
    assert.equal(updates[0].target_commitish, 'master');
    assert.equal(outputs.release_id, draft.id);
  });
});

test('prepare rejects duplicate drafts and already published releases before mutating anything', async () => {
  await withEnvironment(async () => {
    for (const releases of [[draft, { ...draft, id: 456 }], [{ ...draft, draft: false }]]) {
      const github = { paginate: async () => releases, rest: { repos: { listReleases() {} } } };
      await assert.rejects(stepScript('Require successful master checks and prepare one draft')(require, github, { repo: {} }, {}), /Multiple releases|already published/);
    }
  });
});

test('publication addresses the prepared draft by ID and refuses a moved tag', async () => {
  await withEnvironment(async () => {
    let published = 0, tagSha = sourceSha;
    const github = { rest: {
      repos: {
        getRelease: async fields => { assert.equal(fields.release_id, draft.id); return { data: draft }; },
        updateRelease: async fields => { assert.equal(fields.draft, false); published++; return { data: { html_url: 'https://example.test/release' } }; },
      },
      git: { getRef: async () => ({ data: { object: { type: 'commit', sha: tagSha } } }) },
    } };
    const core = { summary: { addHeading() { return this; }, addLink() { return this; }, async write() {} } };
    const context = { repo: {}, ref: 'refs/heads/master', sha: 'b'.repeat(40) };
    await stepScript('Publish the verified draft')(require, github, context, core);
    assert.equal(published, 1);
    tagSha = 'c'.repeat(40);
    await assert.rejects(stepScript('Publish the verified draft')(require, github, context, core), /identity changed/);
    assert.equal(published, 1);
  });
});

test('Actions replaces only its three Android assets in the prepared draft by ID', async () => {
  await withEnvironment(async () => {
    const uploaded = [], deleted = [];
    const github = {
      paginate: async () => [{ id: 5, name: 'arkstage-v1.3.1-android-arm64-v8a.apk' }, { id: 6, name: 'desktop.dmg' }],
      rest: { repos: {
        getRelease: async fields => { assert.equal(fields.release_id, draft.id); return { data: draft }; },
        listReleaseAssets() {},
        deleteReleaseAsset: async fields => { deleted.push(fields.asset_id); },
        uploadReleaseAsset: async fields => { assert.equal(fields.release_id, draft.id); assert.ok(Buffer.isBuffer(fields.data)); uploaded.push(fields.name); },
      } },
    };
    const mockRequire = name => name === 'fs' ? { readFileSync: () => Buffer.from('built by Actions') } : require(name);
    await stepScript('Attach APKs to the release')(mockRequire, github, { repo: {} }, {});
    assert.deepEqual(deleted, [5]);
    assert.deepEqual(uploaded, ['arkstage-v1.3.1-android-arm64-v8a.apk', 'arkstage-v1.3.1-android-arm64-v8a.apk.sha256', 'arkstage-v1.3.1-android-signing.json']);
  });
});
