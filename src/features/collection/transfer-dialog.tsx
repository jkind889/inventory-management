'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '@/components/dialog';
import { api,errorMessage } from '@/lib/api';
import { downloadBackup,exportCsv,importFields,inferMapping,previewCsv,readBackup,readCsv,restoreBackup,type Mapping,type RestoreDraft } from '@/lib/collection-transfer';
import { duplicateIdentity,type Backup,type ImportResult } from '@/shared/collection-tools';
import { getSubmissionAttempt,type SubmissionAttempt } from '@/shared/submission';
import type { Profile } from '@/shared/collection';
export function TransferDialog({mode,profile,close,changed}:{mode:'import'|'export';profile:Profile;close:()=>void;changed:(message:string)=>void}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[csv,setCsv]=useState<Awaited<ReturnType<typeof readCsv>>|null>(null),[mapping,setMapping]=useState<Mapping|null>(null),[skip,setSkip]=useState(true),[existing,setExisting]=useState<Set<string>|null>(null),[backup,setBackup]=useState<RestoreDraft|null>(null),[filename,setFilename]=useState('');
  const attempt=useRef<SubmissionAttempt|null>(null);
  useEffect(()=>{
    if(mode!=='import')return;
    const controller=new AbortController();
    api<{backup:Backup}>('/collection/export',{signal:controller.signal}).then(({backup})=>{
      const categories=new Map(backup.categories.map(c=>[c.id,c.name]));
      if(!controller.signal.aborted)setExisting(new Set(backup.items.map(item=>duplicateIdentity({...item,category:categories.get(item.categoryId)??''}))));
    }).catch(err=>{if(!controller.signal.aborted)setError(errorMessage(err));});return ()=>controller.abort();
  },[mode]);
  const preview=useMemo(()=>csv&&mapping?previewCsv(csv.data,csv.headers,mapping,profile.currency,existing??new Set()):[],[csv,mapping,profile.currency,existing]);
  const invalid=preview.filter(p=>p.error).length,duplicates=preview.filter(p=>p.duplicate).length;
  async function load(file?:File) {
    if(!file)return;setBusy(true);setError('');setMessage('');setFilename(file.name);setCsv(null);setMapping(null);setBackup(null);attempt.current=null;
    try{if(file.name.toLowerCase().endsWith('.zip')){const result=await readBackup(file);setBackup({...result,attempt:null,photoAttempts:new Map(),archiveAttempts:new Map()});}else{const result=await readCsv(file);setCsv(result);setMapping(inferMapping(result.headers));}}catch(err){setError(errorMessage(err));}finally{setBusy(false);}
  }
  async function commit() {
    if(busy)return;setBusy(true);setError('');
    try{
      if(backup){await restoreBackup(backup,setMessage);changed(`${backup.backup.items.length} items and their records were restored.`);return;}
      if(!existing||invalid||!preview.length)throw new Error('Resolve the preview errors before importing.');
      const body=JSON.stringify({rows:preview.flatMap(p=>p.row?[p.row]:[]),skipDuplicates:skip});attempt.current=getSubmissionAttempt(attempt.current,'/collection/import',body);
      const result=await api<ImportResult>('/collection/import',{method:'POST',body,headers:{'Idempotency-Key':attempt.current.key}});attempt.current=null;changed(`Imported ${result.imported} items. Skipped ${result.skipped} duplicates.`);
    }catch(err){setError(errorMessage(err));setBusy(false);}
  }
  async function download(kind:'csv'|'backup') {setBusy(true);setError('');setMessage(kind==='backup'?'Preparing records and photos…':'Preparing CSV files…');try{await(kind==='backup'?downloadBackup():exportCsv());setMessage('Download ready.');}catch(err){setError(errorMessage(err));setMessage('');}finally{setBusy(false);}}
  return <Dialog title={mode==='import'?'Import collection':'Export & backup'} close={close} busy={busy}>
    {mode==='export'?<div className="transfer-options"><p>Exports include your complete account, across all pages and filters.</p><button className="button primary" disabled={busy} onClick={()=>void download('backup')}>Download complete ZIP backup</button><p className="field-help">Items, wishlist, categories, purchase history, reviews, saved views, and cover photo files. Keep this private backup somewhere safe.</p><button className="button secondary" disabled={busy} onClick={()=>void download('csv')}>Export CSV archive</button><p className="field-help">The ZIP contains spreadsheet-safe collection and transaction CSV files. Photos and reviews are included in the ZIP backup.</p></div>:<>
      <p className="field-help">Choose a spreadsheet exported as CSV, or restore a complete ZIP backup into an empty collection.</p><label className="field">Choose CSV or ZIP<input type="file" accept=".csv,.zip,text/csv,application/zip" disabled={busy||!!backup?.result} onChange={e=>void load(e.target.files?.[0])}/></label>{filename&&<p>{filename}</p>}
      {csv&&mapping&&<><h3>Match columns</h3><div className="import-mapping">{importFields.map(field=><label key={field}>{field}{field==='name'||field==='category'?' *':''}<select aria-label={`Map ${field}`} value={mapping[field]} disabled={busy} onChange={e=>{setMapping({...mapping,[field]:e.target.value});setError('');}}><option value="">Not mapped</option>{csv.headers.map(h=><option key={h} value={h}>{h}</option>)}</select></label>)}</div><p className="field-help">Dates use YYYY-MM-DD. Leave amount blank for existing possessions. A price records a real expense, so it requires a date. Missing categories are created.</p><label className="check-field"><input type="checkbox" checked={skip} disabled={busy} onChange={e=>setSkip(e.target.checked)}/> Skip possible duplicates (same name, category, and acquisition date)</label><h3>Preview</h3><p>{preview.length} rows · {invalid} errors · {duplicates} possible duplicates{existing===null?' · Checking existing items…':''}</p><div className="import-preview"><table><thead><tr><th>Row</th><th>Item</th><th>Category</th><th>Status</th></tr></thead><tbody>{preview.map(p=><tr key={p.line}><td>{p.line}</td><td>{p.row?.name??'—'}</td><td>{p.row?.category??'—'}</td><td>{p.error??(p.duplicate?(skip?'Will skip duplicate':'Possible duplicate'):'Ready')}</td></tr>)}</tbody></table></div></>}
      {backup&&<><h3>Restore preview</h3><p>{backup.backup.items.length} items, {backup.backup.transactions.length} purchases, {backup.backup.reviews.length} reviews, and {backup.backup.photos.length} photos.</p><p className="field-help">Restores {backup.backup.profile.currency} and {backup.backup.profile.timezone} preferences. Your current collection must be empty. Records receive new IDs; their dates, costs, and links are preserved. If a photo fails, keep this dialog open and retry to finish.</p></>}
      <div className="dialog-actions"><button className="button secondary" disabled={busy} onClick={close}>Cancel</button><button className="button primary" disabled={busy||(!backup&&(!preview.length||!!invalid||!existing))} onClick={()=>void commit()}>{busy?'Working…':backup?'Restore backup':'Import items'}</button></div>
    </>}{message&&<p role="status">{message}</p>}{error&&<p role="alert" className="form-message error">{error}</p>}
  </Dialog>;
}
