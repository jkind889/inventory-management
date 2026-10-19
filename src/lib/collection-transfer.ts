import { backupInput, duplicateIdentity, importRow, type Backup, type ImportRow, type RestoreResult } from '@/shared/collection-tools';
import { parsePrice } from '@/shared/collection';
import { api } from './api';
import { getSubmissionAttempt, type SubmissionAttempt } from '@/shared/submission';
import { uploadPhoto } from './photo-upload';
import type { PhotoUpload } from '@/shared/photos';
export const importFields = ['name','category','acquiredOn','description','state','amount','currency','merchant'] as const;
export type ImportField=typeof importFields[number];
export type Mapping=Record<ImportField,string>;
export function inferMapping(headers:string[]):Mapping {
  const aliases:Record<ImportField,string[]>= {name:['name','item','item name'],category:['category','collection'],acquiredOn:['acquiredon','acquired on','date','purchase date'],description:['description','notes','note'],state:['state','status'],amount:['amount','price','purchase amount'],currency:['currency'],merchant:['merchant','store']};
  return Object.fromEntries(importFields.map(field=>[field,headers.find(h=>aliases[field].includes(h.trim().toLowerCase()))??''])) as Mapping;
}
export async function readCsv(file:File) {
  if(file.size>4_000_000)throw new Error('CSV files must be 4 MB or smaller.');
  const {default:Papa}=await import('papaparse');
  const parsed=Papa.parse<string[]>(await file.text(),{skipEmptyLines:'greedy'});
  if(parsed.errors.length)throw new Error(`CSV could not be read: ${parsed.errors[0].message}`);
  const [headers,...data]=parsed.data;
  if(!headers?.length||!data.length)throw new Error('Choose a CSV with a header and at least one data row.');
  if(data.length>500)throw new Error('Import up to 500 rows at a time. Split this file into smaller files.');
  if(new Set(headers).size!==headers.length||headers.some(h=>!h.trim()))throw new Error('CSV column names must be non-empty and unique.');
  if(data.some(r=>r.length!==headers.length))throw new Error('Every CSV row must have the same number of columns as the header.');
  return {headers,data};
}
export function previewCsv(data:string[][],headers:string[],mapping:Mapping,currency:string,existing:Set<string>) {
  const seen=new Set(existing);
  return data.map((cells,index)=>{
    const read=(field:ImportField)=>mapping[field]?cells[headers.indexOf(mapping[field])]?.trim()??'':'';
    const amount=read('amount');
    const amountMinor=amount?parsePrice(amount):null;
    if(amount&&amountMinor===null)return {line:index+2,error:'Amount must be positive, with up to two decimal places.'};
    const parsed=importRow.safeParse({name:read('name'),category:read('category'),acquiredOn:read('acquiredOn')||null,description:read('description')||null,state:read('state').toLowerCase()||'owned',amountMinor,currency:amount?read('currency')||currency:undefined,merchant:read('merchant')||null});
    if(!parsed.success)return {line:index+2,error:parsed.error.issues.map(x=>`${x.path.join('.')}: ${x.message}`).join('; ')};
    if(parsed.data.amountMinor!==null && parsed.data.currency!==currency)return {line:index+2,error:`Use ${currency} for purchases in this account.`};
    const identity=duplicateIdentity(parsed.data),duplicate=seen.has(identity);seen.add(identity);
    return {line:index+2,row:parsed.data,duplicate};
  });
}
function saveFile(bytes:Uint8Array|string,name:string,type:string) {
  const blob=new Blob([typeof bytes==='string'?bytes:Uint8Array.from(bytes)],{type});
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export async function downloadBackup() {
  const {backup,photoDownloads}=await api<{backup:Backup;photoDownloads:{id:string;url:string}[]}>('/collection/backup');
  const {zipSync,strToU8}=await import('fflate');
  const json=strToU8(JSON.stringify(backup,null,2));
  if(json.length>20_000_000 || json.length+backup.photos.reduce((sum,p)=>sum+p.byteSize,0)>190_000_000)throw new Error('This collection exceeds the supported backup size (20 MB records, 190 MB total).');
  const files:Record<string,Uint8Array>={'inventory.json':json};
  const urls=new Map(photoDownloads.map(p=>[p.id,p.url]));
  // Download sequentially to bound memory and avoid saturating private Storage.
  for(const photo of backup.photos) {
    const url=urls.get(photo.id);
    if(!url)throw new Error('A cover photo is unavailable. Retry the backup.');
    const response=await fetch(url);if(!response.ok)throw new Error('A cover photo could not be downloaded. Retry the backup.');
    const bytes=new Uint8Array(await response.arrayBuffer());
    const checksum=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
    if(bytes.length!==photo.byteSize||checksum!==photo.checksum)throw new Error('A photo changed during backup. Try again.');
    files[photo.file]=bytes;
  }
  saveFile(zipSync(files,{level:0}),`inventory-backup-${backup.exportedAt.slice(0,10)}.zip`,'application/zip');
}
export async function exportCsv() {
  const [{backup},{default:Papa}]=await Promise.all([api<{backup:Backup}>('/collection/export'),import('papaparse')]);
  const names=new Map(backup.categories.map(c=>[c.id,c.name]));
  const byItem=new Map<string,Backup["transactions"]>();
  for(const transaction of backup.transactions) if(transaction.itemId) { const group=byItem.get(transaction.itemId)??[];group.push(transaction);byItem.set(transaction.itemId,group); }
  const rows=backup.items.map(item=>{
    const expenses=byItem.get(item.id)??[];
    const total=expenses.reduce((sum,t)=>sum+BigInt(t.amountMinor),0n);
    const portable=expenses.length===1&&expenses[0].occurredOn===item.acquiredOn&&expenses[0].categoryId===item.categoryId?expenses[0]:null;
    return {name:item.name,category:names.get(item.categoryId),acquiredOn:item.acquiredOn??'',description:item.description??'',state:item.state,amount:portable?(portable.amountMinor/100).toFixed(2):'',currency:backup.profile.currency,merchant:portable?.merchant??'',recordedCost:expenses.length?(total/100n).toString()+'.'+(total%100n).toString().padStart(2,'0'):'',archived:item.archivedAt?'yes':'no'};
  });
  const {zipSync,strToU8}=await import('fflate');
  const files={
    'collection.csv':strToU8(Papa.unparse(rows,{escapeFormulae:true})),
    'transactions.csv':strToU8(Papa.unparse(backup.transactions.map(t=>({...t,category:names.get(t.categoryId)})),{escapeFormulae:true})),
  };
  saveFile(zipSync(files),`inventory-csv-${backup.exportedAt.slice(0,10)}.zip`,'application/zip');
}
export async function readBackup(file:File) {
  if(file.size>200_000_000)throw new Error('Backups must be 200 MB or smaller.');
  const {unzipSync,strFromU8}=await import('fflate');
  let total=0;
  const files=unzipSync(new Uint8Array(await file.arrayBuffer()),{filter(entry){total+=entry.originalSize;if(total>200_000_000||entry.originalSize>20_000_000)throw new Error('Backup expands beyond the supported size.');return entry.name==='inventory.json'||/^photos\/[0-9a-f-]+\.(png|jpg|webp)$/.test(entry.name);}});
  if(!files['inventory.json'])throw new Error('This ZIP does not contain inventory.json.');
  const backup=backupInput.parse(JSON.parse(strFromU8(files['inventory.json'])));
  for(const p of backup.photos) {
    const bytes=files[p.file];
    if(!bytes||bytes.length!==p.byteSize)throw new Error(`The backup is missing photo ${p.file}.`);
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes)))).map(x=>x.toString(16).padStart(2,'0')).join('');
    if(digest!==p.checksum)throw new Error('A photo in this backup is corrupted.');
  }
  return {backup,files};
}
export type RestoreDraft=Awaited<ReturnType<typeof readBackup>> & {attempt:SubmissionAttempt|null; photoAttempts:Map<string,{reserve:SubmissionAttempt|null;complete:SubmissionAttempt|null}>; archiveAttempts:Map<string,SubmissionAttempt>; result?:RestoreResult};
export async function restoreBackup(draft:RestoreDraft,progress:(message:string)=>void) {
  const body=JSON.stringify(draft.backup);
  draft.attempt=getSubmissionAttempt(draft.attempt,'/collection/restore',body);
  progress('Restoring collection records…');
  const result=draft.result??await api<RestoreResult>('/collection/restore',{method:'POST',body,headers:{'Idempotency-Key':draft.attempt.key}});draft.result=result;
  for(const [index,photo] of draft.backup.photos.entries()) {
    progress(`Restoring photo ${index+1} of ${draft.backup.photos.length}…`);
    const itemId=result.itemIds[photo.itemId],path=`/items/${itemId}/photo/uploads`;
    const photoBody=JSON.stringify({byteSize:photo.byteSize,mimeType:photo.mimeType,checksum:photo.checksum,expectedCoverId:null});
    const attempts=draft.photoAttempts.get(photo.id)??{reserve:null,complete:null};draft.photoAttempts.set(photo.id,attempts);
    attempts.reserve=getSubmissionAttempt(attempts.reserve,path,photoBody);
    const {upload,replayed}=await api<{upload:PhotoUpload;replayed:boolean}>(path,{method:'POST',body:photoBody,headers:{'Idempotency-Key':attempts.reserve.key}});
    const completionPath=`${path}/${upload.id}/complete`;attempts.complete=getSubmissionAttempt(attempts.complete,completionPath,'{}');
    // Complete first also recovers a previously successful/lost completion response.
    if(replayed) try {await api(completionPath,{method:'POST',body:'{}',headers:{'Idempotency-Key':attempts.complete.key}});continue;} catch { /* Missing bytes on the initial attempt; upload and then retry completion. */ }
    const file=new File([Uint8Array.from(draft.files[photo.file])],photo.file,{type:photo.mimeType});
    try {await uploadPhoto(file,upload.storagePath,new AbortController().signal,()=>{});} catch { /* A lost upload response is checked by the completion endpoint. */ }
    await api(completionPath,{method:'POST',body:'{}',headers:{'Idempotency-Key':attempts.complete.key}});
  }
  for(const archived of result.archived) {
    const path=`/items/${archived.id}`,body=JSON.stringify({archivedAt:archived.archivedAt});
    const attempt=getSubmissionAttempt(draft.archiveAttempts.get(archived.id)??null,path,body);draft.archiveAttempts.set(archived.id,attempt);
    await api(path,{method:'PATCH',body,headers:{'Idempotency-Key':attempt.key}});
  }
}
export function importPayload(rows:ImportRow[],skipDuplicates:boolean){return {rows,skipDuplicates};}
