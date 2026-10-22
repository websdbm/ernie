import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitVault, VaultPathError } from './vault.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ernie-vault-review-'));
  roots.push(root);
  const vault = new GitVault({ dir: join(root, 'vault') });
  await vault.ensure();
  const outside = join(root, 'outside.md');
  await writeFile(outside, 'PRIVATE ORIGINAL');
  return { root, vault, outside };
}
describe('confini del vault', () => {
  it('non legge o indicizza symlink markdown provenienti dal repository', async () => {
    const { vault, outside } = await fixture();
    await symlink(outside, join(vault.dir, 'imported.md'));
    expect(await vault.list()).not.toContain('imported.md');
    await expect(vault.read('imported.md')).rejects.toBeInstanceOf(VaultPathError);
  });
  it('rifiuta scritture attraverso directory symlink e valida tutto il batch prima di toccare file', async () => {
    const { root, vault, outside } = await fixture();
    await symlink(root, join(vault.dir, 'escape'));
    await expect(
      vault.commit(
        [
          { path: 'safe.md', content: 'new' },
          { path: 'escape/outside.md', content: 'OVERWRITTEN' },
        ],
        'unsafe',
      ),
    ).rejects.toBeInstanceOf(VaultPathError);
    expect(await readFile(outside, 'utf8')).toBe('PRIVATE ORIGINAL');
    expect(await vault.read('safe.md')).toBeNull();
  });
});
