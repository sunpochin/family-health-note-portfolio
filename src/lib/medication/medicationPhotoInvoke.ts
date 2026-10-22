/*
檔案用途：組出「拍藥袋」兩支 Edge Function（medication-ocr、medication-ai-draft）的 supabase.functions.invoke 選項（body＋標頭）。
所在層：src/lib/medication；純函式，不碰網路，只決定送哪些標頭與照片位元組。
主要關聯：src/features/medication/components/MedicationPhotoOcrSection.tsx、MedicationAiDraftSection.tsx（兩個呼叫端）、
  supabase/functions/_shared/medicationPhotoCors.ts（Function 端的預檢允許清單）、
  tests/unit/medicationPhotoFunctionsCors.test.ts（用真的 supabase-js client 把兩邊接起來）。
為什麼抽出來：「前端送什麼標頭」與「Function 允許什麼標頭」分屬兩邊，只有瀏覽器預檢會把兩者接起來；
  兩個元件原本各自在 invoke 呼叫裡寫標頭，測試沒辦法拿到「元件實際送的那一份」。集中在這裡，測試與元件用同一份。
  以後要加新標頭，改這裡、同時更新 _shared/medicationPhotoCors.ts，否則上面那支測試會紅燈。
*/

export function buildMedicationPhotoInvokeOptions(patientId: string, photo: Blob, contentType: string) {
  return {
    body: photo,
    // 大小寫必須是 'Content-Type'（不是 'content-type'）：supabase-js functions.invoke() 用
    // `Object.prototype.hasOwnProperty.call(headers, 'Content-Type')`（區分大小寫）判斷呼叫端
    // 是否已自訂 content type；沒偵測到就會自動幫 Blob body 加一個 `Content-Type: application/octet-stream`。
    // 因為物件的 key 是大小寫不同的兩個獨立屬性，兩個標頭都會被送出，瀏覽器 fetch 合併成
    // "application/octet-stream, image/webp" 這種畸形值，Edge Function 端 `.startsWith('image/')`
    // 判斷失敗、悄悄退回 'image/jpeg'——實際位元組其實是 WebP，mimeType 標錯導致 Gemini
    // 解碼失敗（issue #808 迴歸根因；base Vision OCR 不需要準確的 mimeType 才沒受影響）。
    // x-patient-id 是自訂標頭：Function 端的 CORS 允許清單必須列它，否則瀏覽器在預檢後就擋下 POST（issue #1236）。
    headers: { 'x-patient-id': patientId, 'Content-Type': contentType },
  }
}
