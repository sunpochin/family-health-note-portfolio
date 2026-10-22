/*
檔案用途：驗證 PORTFOLIO-01 portfolio:build 自動移除「依賴未公開檔案的測試」的純判斷邏輯。
所在層：tests/unit；不碰檔案系統，檔案存在與否用 Set 模擬。
主要關聯：scripts/portfolio/testPruneLogic.ts、scripts/portfolio/build.ts、
docs/operations/portfolio-pipeline.md 第 3.1 節。
這個檔案的 fixture 字串本身就長得像依賴未公開檔案的寫法，所以帶有 portfolio-prune: keep 標記，
否則 portfolio:build 會把它從公開版移除，公開 CI 就測不到這支偵測邏輯。
*/
import { describe, expect, test } from 'bun:test'
import { KEEP_MARKER, findUnpublishedReference, planTestPruning } from '../../scripts/portfolio/testPruneLogic'

const privatePaths = new Set([
  'supabase/migrations',
  'supabase/migrations/001_init.sql',
  'supabase/functions',
  'supabase/functions/_shared/cron.ts',
  'scripts/seed.ts',
  'src/lib/weight.ts',
  'tests/unit/helpers/sqlHelper.ts',
  'tests/unit/helpers/pureHelper.ts',
])
const outputPaths = new Set(['src/lib/weight.ts', 'tests/unit/helpers/sqlHelper.ts', 'tests/unit/helpers/pureHelper.ts'])
const inPrivate = (p: string) => privatePaths.has(p)
const inOutput = (p: string) => outputPaths.has(p)
const file = 'tests/unit/example.test.ts'

describe('findUnpublishedReference', () => {
  test('flags readFileSync(new URL(...)) of an unpublished migration', () => {
    const content = "readFileSync(new URL('../../supabase/migrations/001_init.sql', import.meta.url), 'utf8')"
    expect(findUnpublishedReference(file, content, inPrivate, inOutput)).toBe('supabase/migrations/001_init.sql')
  })

  test('flags an extensionless import of an unpublished module', () => {
    const content = "import { parseCron } from '../../supabase/functions/_shared/cron'"
    expect(findUnpublishedReference(file, content, inPrivate, inOutput)).toBe('supabase/functions/_shared/cron')
  })

  test('uses the static prefix of a template literal', () => {
    const content = 'readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url))'
    expect(findUnpublishedReference(file, content, inPrivate, inOutput)).toBe('supabase/migrations')
  })

  test('flags repo-root-relative literals such as join(rootDir, ...)', () => {
    const content = "const dir = join(rootDir, 'supabase/functions')"
    expect(findUnpublishedReference(file, content, inPrivate, inOutput)).toBe('supabase/functions')
  })

  test('ignores imports that are published', () => {
    const content = "import { toKg } from '../../src/lib/weight'\nimport { h } from './helpers/pureHelper'"
    expect(findUnpublishedReference(file, content, inPrivate, inOutput)).toBeNull()
  })

  test('flags paths read through custom helpers or spawned commands', () => {
    expect(findUnpublishedReference(file, 'const sql = read(`supabase/migrations/${name}`)', inPrivate, inOutput)).toBe('supabase/migrations')
    expect(findUnpublishedReference(file, "Bun.spawnSync([process.execPath, 'scripts/seed.ts'])", inPrivate, inOutput)).toBe('scripts/seed.ts')
  })

  test('keeps a file that carries the keep marker', () => {
    const content = `// ${KEEP_MARKER}\nimport { parseCron } from '../../supabase/functions/_shared/cron'`
    expect(findUnpublishedReference(file, content, inPrivate, inOutput)).toBeNull()
  })

  test('ignores strings that are not private repo paths', () => {
    const content = "const mime = 'image/png'\nconst url = 'https://example.test/supabase/functions'\nconst word = 'scripts'"
    expect(findUnpublishedReference(file, content, inPrivate, inOutput)).toBeNull()
  })
})

describe('planTestPruning', () => {
  test('removes tests transitively through a helper that depends on unpublished files', () => {
    const files = new Map([
      ['tests/unit/helpers/sqlHelper.ts', "export const sql = readFileSync(new URL('../../../supabase/migrations/001_init.sql', import.meta.url))"],
      ['tests/unit/usesSqlHelper.test.ts', "import { sql } from './helpers/sqlHelper'"],
      ['tests/unit/pure.test.ts', "import { h } from './helpers/pureHelper'"],
    ])
    const removed = planTestPruning(files, inPrivate, inOutput)
    expect([...removed.keys()].sort()).toEqual(['tests/unit/helpers/sqlHelper.ts', 'tests/unit/usesSqlHelper.test.ts'])
  })
})
