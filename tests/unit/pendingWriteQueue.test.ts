/*
檔案用途：驗證共用離線寫入佇列在「送出途中佇列被改動」時的契約——已撤回的項目不能照樣送出，送出時要用最新版本；
  也驗證帳號切換時停止舊輪次、整個帳號一起補送（flushAll，issue #1125）與每筆失敗原因的回報。
所在層：tests/unit；分區、去重、保序與錯誤分類的基本契約已由 bloodPressurePendingQueue.test.ts 透過血壓 adapter 覆蓋，這裡只測泛化後新增的行為。
主要關聯：src/lib/pendingWriteQueue.ts、src/lib/medication/medicationPendingQueue.ts（服藥打卡可在送出前撤回）。
*/
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createPendingWriteQueue, type PendingWriteBase } from '../../src/lib/pendingWriteQueue'

type Item = PendingWriteBase & { note: string }

const originalLocalStorage = globalThis.localStorage
const values = new Map<string, string>()

beforeEach(() => {
  values.clear()
  ;(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
    // flushAll 要列舉同一帳號的所有病人桶（issue #1125），替身也要能列 key。
    get length() { return values.size },
    key: index => [...values.keys()][index] ?? null,
  } as Storage
})
afterEach(() => {
  if (originalLocalStorage) {
    ;(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = originalLocalStorage
  } else {
    delete (globalThis as typeof globalThis & { localStorage?: Storage }).localStorage
  }
})

const isItem = (value: unknown): value is Item => typeof value === 'object' && value !== null && typeof (value as Item).id === 'string' && typeof (value as Item).note === 'string'
const queue = createPendingWriteQueue<Item>({ namespace: 'test.pending-write.v1', logLabel: 'test pending queue', isValid: isItem, isSameWrite: (submitted, latest) => JSON.stringify(submitted) === JSON.stringify(latest) })
const item = (id: string, minute: number, note = 'original'): Item => ({
  id, patient_id: 'patient-a', recorded_by: 'care@example.com', queued_at: `2026-10-06T01:0${minute}:00.000Z`, note,
})

describe('pending write queue', () => {
  test('preserves a replacement written while that same record was in flight', async () => {
    const original = item('same-dose', 1)
    queue.enqueue(original)
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const draining = queue.flush({ patientId: original.patient_id, recordedBy: original.recorded_by, save: async () => { await gate } })
    // 另一分頁撤回正在送的那一劑；回來的舊成功不能按 id 刪掉較新的撤回標記。
    const withdrawal = { ...original, note: 'withdrawal' }
    queue.enqueue(withdrawal)
    release()
    const result = await draining
    expect(result.synced).toEqual([original])
    expect(result.remaining).toEqual([withdrawal])
  })
  test('skips a record that was removed while an earlier record was still sending', async () => {
    queue.enqueue(item('first', 1))
    queue.enqueue(item('second', 2))
    const sent: string[] = []

    const result = await queue.flush({
      patientId: 'patient-a',
      recordedBy: 'care@example.com',
      save: async record => {
        sent.push(record.id)
        // 第一筆等待回應期間，使用者在畫面上撤回第二筆（例如服藥打卡按錯）。
        if (record.id === 'first') queue.remove(item('second', 2))
      },
    })

    expect(sent).toEqual(['first'])
    expect(result.synced.map(record => record.id)).toEqual(['first'])
    expect(result.remaining).toEqual([])
  })

  test('sends the latest stored version of a record, not the snapshot taken when the flush started', async () => {
    queue.enqueue(item('first', 1))
    queue.enqueue(item('second', 2))
    const notes: string[] = []

    await queue.flush({
      patientId: 'patient-a',
      recordedBy: 'care@example.com',
      save: async record => {
        notes.push(record.note)
        if (record.id === 'first') queue.enqueue(item('second', 2, 'updated'))
      },
    })

    expect(notes).toEqual(['original', 'updated'])
  })

  test('keeps different patients in separate storage buckets', () => {
    queue.enqueue(item('first', 1))
    queue.enqueue({ ...item('other-patient', 2), patient_id: 'patient-b' })

    expect(queue.read('patient-a', 'CARE@example.com ').map(record => record.id)).toEqual(['first'])
    expect(queue.read('patient-b', 'care@example.com').map(record => record.id)).toEqual(['other-patient'])
    expect([...values.keys()].every(key => key.includes('patient-patient-a') || key.includes('patient-patient-b'))).toBe(true)
  })

  test('reports each failed record with its error and whether it will be retried', async () => {
    queue.enqueue(item('rejected', 1))
    queue.enqueue(item('offline', 2))
    queue.enqueue(item('not-tried', 3))
    const rejection = { code: '42501', message: 'permission denied' }
    const offline = { message: 'TypeError: Failed to fetch', code: '', status: 0 }

    const result = await queue.flush({
      patientId: 'patient-a',
      recordedBy: 'care@example.com',
      save: async record => {
        if (record.id === 'rejected') throw rejection
        throw offline
      },
    })

    // 畫面要靠這份清單講出真正的原因（issue #1125）；斷線之後的那筆沒嘗試，所以不在清單裡。
    expect(result.failures).toEqual([
      { record: item('rejected', 1), error: rejection, retryable: false },
      { record: item('offline', 2), error: offline, retryable: true },
    ])
    expect(result.remaining.map(record => record.id)).toEqual(['rejected', 'offline', 'not-tried'])
  })
})

describe('pending write queue: every patient for the account (issue #1125)', () => {
  const forPatient = (patientId: string, id: string, minute: number, recordedBy = 'care@example.com'): Item => ({ ...item(id, minute), patient_id: patientId, recorded_by: recordedBy })

  test('sends the patient on screen first, then the others by their oldest waiting record', async () => {
    queue.enqueue(forPatient('patient-c', 'c-1', 2))
    queue.enqueue(forPatient('patient-b', 'b-1', 1))
    queue.enqueue(forPatient('patient-a', 'a-1', 3))
    const sent: string[] = []

    const result = await queue.flushAll({
      recordedBy: 'CARE@example.com',
      firstPatientId: 'patient-a',
      save: async record => { sent.push(`${record.patient_id}:${record.id}`) },
    })

    expect(sent).toEqual(['patient-a:a-1', 'patient-b:b-1', 'patient-c:c-1'])
    expect(result.synced).toHaveLength(3)
    expect(result.remaining).toEqual([])
  })

  test('also sends other patients when the patient on screen has nothing waiting', async () => {
    queue.enqueue(forPatient('patient-a', 'a-1', 1))

    const sent: string[] = []
    await queue.flushAll({ recordedBy: 'care@example.com', firstPatientId: 'patient-b', save: async record => { sent.push(record.id) } })

    expect(sent).toEqual(['a-1'])
    expect(queue.readAll('care@example.com')).toEqual([])
  })

  test('never sends another account\'s queue, even when that email ends with this one', async () => {
    // 兩個帳號的 storage key 都以 `-care@example.com` 結尾；只看 key 字尾會把別人的紀錄當成自己的。
    queue.enqueue(forPatient('patient-a', 'mine', 1))
    queue.enqueue(forPatient('patient-a', 'theirs', 2, 'other-care@example.com'))
    const sent: string[] = []

    await queue.flushAll({ recordedBy: 'care@example.com', save: async record => { sent.push(record.id) } })

    expect(sent).toEqual(['mine'])
    expect(queue.read('patient-a', 'other-care@example.com').map(record => record.id)).toEqual(['theirs'])
  })

  test('stops at the first temporary failure instead of trying every other patient', async () => {
    queue.enqueue(forPatient('patient-a', 'a-1', 1))
    queue.enqueue(forPatient('patient-b', 'b-1', 2))
    const attempted: string[] = []

    const result = await queue.flushAll({
      recordedBy: 'care@example.com',
      firstPatientId: 'patient-a',
      save: async record => {
        attempted.push(record.id)
        throw { message: 'TypeError: Failed to fetch', code: '', status: 0 }
      },
    })

    // 斷線時換下一位病人也一樣會失敗；下一次觸發再從頭試。
    expect(attempted).toEqual(['a-1'])
    expect(result.blocked).toBe(true)
    expect(result.remaining.map(record => record.id)).toEqual(['a-1', 'b-1'])
  })

  test('keeps going to the next patient after a permanent rejection', async () => {
    queue.enqueue(forPatient('patient-a', 'a-1', 1))
    queue.enqueue(forPatient('patient-b', 'b-1', 2))

    const result = await queue.flushAll({
      recordedBy: 'care@example.com',
      firstPatientId: 'patient-a',
      save: async record => {
        if (record.id === 'a-1') throw { code: '42501', message: 'permission denied' }
      },
    })

    expect(result.synced.map(record => record.id)).toEqual(['b-1'])
    expect(result.remaining.map(record => record.id)).toEqual(['a-1'])
    expect(result.failures.map(failure => [failure.record.id, failure.retryable])).toEqual([['a-1', false]])
  })

  test('notifies after each successful write is removed and before the next patient starts', async () => {
    queue.enqueue(forPatient('patient-a', 'a-1', 1))
    queue.enqueue(forPatient('patient-b', 'b-1', 2))
    const steps: string[] = []

    await queue.flushAll({
      recordedBy: 'care@example.com',
      firstPatientId: 'patient-a',
      save: async record => {
        steps.push(`save:${record.id}`)
        return `saved:${record.id}`
      },
      onSynced: (record, result) => {
        steps.push(`synced:${record.id}:${result}`)
        expect(queue.read(record.patient_id, record.recorded_by).some(item => item.id === record.id)).toBe(false)
      },
    })

    // 下一位病人的網路請求可能停很久；前一筆已成功的狀態必須先送到畫面。
    expect(steps).toEqual([
      'save:a-1', 'synced:a-1:saved:a-1',
      'save:b-1', 'synced:b-1:saved:b-1',
    ])
  })

  test('stops the old account drain after an in-flight write finishes', async () => {
    queue.enqueue(forPatient('patient-a', 'a-1', 1))
    queue.enqueue(forPatient('patient-a', 'a-2', 2))
    queue.enqueue(forPatient('patient-b', 'b-1', 3))
    let ownerIsCurrent = true
    let releaseFirstWrite = () => {}
    const firstWriteGate = new Promise<void>(resolve => { releaseFirstWrite = resolve })
    const attempted: string[] = []

    const draining = queue.flushAll({
      recordedBy: 'care@example.com',
      firstPatientId: 'patient-a',
      shouldContinue: () => ownerIsCurrent,
      save: async record => {
        attempted.push(record.id)
        if (record.id === 'a-1') await firstWriteGate
      },
    })

    await Promise.resolve()
    ownerIsCurrent = false
    releaseFirstWrite()
    const result = await draining

    expect(attempted).toEqual(['a-1'])
    expect(result.synced.map(record => record.id)).toEqual(['a-1'])
    expect(result.remaining.map(record => record.id)).toEqual(['a-2', 'b-1'])
    expect(result.failures).toEqual([])
  })

  test('still sends the patient on screen when the browser cannot list storage keys', async () => {
    queue.enqueue(forPatient('patient-a', 'a-1', 1))
    const storage = globalThis.localStorage as Storage & { key: (index: number) => string | null }
    storage.key = () => { throw new Error('storage enumeration blocked') }
    const sent: string[] = []

    await queue.flushAll({ recordedBy: 'care@example.com', firstPatientId: 'patient-a', save: async record => { sent.push(record.id) } })

    expect(sent).toEqual(['a-1'])
  })
})
