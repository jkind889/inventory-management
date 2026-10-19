'use client';
import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Dialog } from '@/components/dialog';
import { api, errorMessage } from '@/lib/api';
import { getSubmissionAttempt, type SubmissionAttempt } from '@/shared/submission';
import { validFilterRange, viewFilters, type Preferences } from '@/shared/collection-tools';
import { type Category, type Profile } from '@/shared/collection';
const TransferDialog=dynamic(()=>import('./transfer-dialog').then(m=>m.TransferDialog));
export type FilterDraft={state:string;from:string;to:string;minAmountMinor:string;maxAmountMinor:string};
export const emptyFilters:FilterDraft={state:'owned',from:'',to:'',minAmountMinor:'',maxAmountMinor:''};
type View={q:string;categoryId?:string;sort:string;filters:FilterDraft};
function priceFilter(value:string) {
  if(!value.trim())return '';
  if(!/^\d{1,10}(\.\d{1,2})?$/.test(value))return 'invalid';
  const [whole,cents='']=value.split('.');return String(Number(whole)*100+Number(cents.padEnd(2,'0')));
}
function priceDisplay(value:string) {return !value||value==='invalid'?'':(Number(value)/100).toFixed(2);}
export function CollectionTools({profile,categories,query,category,sort,filters,checked,applyView,changeFilters,changed,clearChecked,refresh,recentCategory}: {
  profile:Profile;categories:Category[];query:string;category:string;sort:string;filters:FilterDraft;checked:string[];
  applyView:(view:View)=>void;changeFilters:(filters:FilterDraft)=>void;changed:(message:string)=>void;clearChecked:()=>void;refresh:number;recentCategory:(ids:string[])=>void;
}) {
  const [prefs,setPrefs]=useState<Preferences|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[saveName,setSaveName]=useState(''),[transfer,setTransfer]=useState<'import'|'export'|null>(null),[bulk,setBulk]=useState(false),[advanced,setAdvanced]=useState(false);
  const attempt=useRef<SubmissionAttempt|null>(null);
  const draftView=useRef<{name:string;id:string}|null>(null);
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    api<Preferences>('/collection/preferences',{signal:controller.signal}).then(data=>{if(!controller.signal.aborted){setPrefs(data);recentCategory(data.recentCategoryIds.filter(id=>categories.some(c=>c.id===id))); }}).catch(err=>{if(!controller.signal.aborted)setError(errorMessage(err));});
    return ()=>controller.abort();
  },[refresh,retry,recentCategory,categories]);
  async function savePreferences(next:Preferences) {
    const body=JSON.stringify(next);attempt.current=getSubmissionAttempt(attempt.current,'/collection/preferences',body);
    setBusy(true);setError('');
    try {const saved=await api<Preferences>('/collection/preferences',{method:'PUT',body,headers:{'Idempotency-Key':attempt.current.key}});setPrefs(saved);attempt.current=null;draftView.current=null;setSaveName('');}catch(err){setError(errorMessage(err));}finally{setBusy(false);}
  }
  function saveView(event:React.FormEvent) {
    event.preventDefault();if(!prefs||busy)return;
    const parsed=viewFilters.safeParse({q:query,categoryId:category||undefined,sort,state:filters.state,from:filters.from||undefined,to:filters.to||undefined,minAmountMinor:filters.minAmountMinor||undefined,maxAmountMinor:filters.maxAmountMinor||undefined});
    if(!parsed.success||!validFilterRange(parsed.data)){setError('Check the date and price ranges before saving this view.');return;}
    const matching=prefs.savedViews.find(v=>v.name.toLowerCase()===saveName.trim().toLowerCase());
    const name=saveName.trim();
    const id=matching?.id ?? (draftView.current?.name===name?draftView.current.id:crypto.randomUUID());
    draftView.current={name,id};
    const next={id,name,filters:parsed.data};
    void savePreferences({...prefs,savedViews:[...prefs.savedViews.filter(v=>v.id!==next.id),next]});
  }
  const active=filters.state!=='owned'||Object.entries(filters).some(([k,v])=>k!=='state'&&!!v);
  return <div className="collection-tools">
    <div className="collection-tool-actions"><button className="button secondary" aria-expanded={advanced} onClick={()=>setAdvanced(v=>!v)}>Filters{active?' •':''}</button><button className="button secondary" onClick={()=>setTransfer('import')}>Import</button><button className="button secondary" onClick={()=>setTransfer('export')}>Export & backup</button><button className="button secondary" disabled={!checked.length} onClick={()=>setBulk(true)}>Edit selected{checked.length?` (${checked.length})`:''}</button></div>
    {advanced&&<div className="advanced-filters">
      <label>Ownership state<select aria-label="Filter ownership state" value={filters.state} onChange={e=>changeFilters({...filters,state:e.target.value})}><option value="all">All states</option><option value="owned">Owned</option><option value="wishlist">Wishlist</option><option value="sold">Sold</option><option value="returned">Returned</option><option value="donated">Donated</option></select></label>
      <label>Acquired from<input aria-label="Acquired from" type="date" min="1900-01-01" value={filters.from} onChange={e=>changeFilters({...filters,from:e.target.value})}/></label><label>Acquired to<input aria-label="Acquired to" type="date" min="1900-01-01" value={filters.to} onChange={e=>changeFilters({...filters,to:e.target.value})}/></label>
      <label>Min price ({profile.currency})<input aria-label="Minimum price" inputMode="decimal" placeholder="0.00" key={`min:${filters.minAmountMinor}`} defaultValue={priceDisplay(filters.minAmountMinor)} onBlur={e=>changeFilters({...filters,minAmountMinor:priceFilter(e.target.value)})}/></label><label>Max price ({profile.currency})<input aria-label="Maximum price" inputMode="decimal" placeholder="Any" key={`max:${filters.maxAmountMinor}`} defaultValue={priceDisplay(filters.maxAmountMinor)} onBlur={e=>changeFilters({...filters,maxAmountMinor:priceFilter(e.target.value)})}/></label>
      <button className="text-button" onClick={()=>{applyView({q:'',sort:'newest',filters:emptyFilters});}}>Clear all filters</button>
    </div>}
    <div className="saved-view-controls"><label>Saved views<select aria-label="Saved views" value="" disabled={busy||!prefs} onChange={e=>{
      const v=prefs?.savedViews.find(v=>v.id===e.target.value);if(!v)return;applyView({q:v.filters.q,categoryId:v.filters.categoryId,sort:v.filters.sort,filters:{state:v.filters.state,from:v.filters.from??'',to:v.filters.to??'',minAmountMinor:v.filters.minAmountMinor===undefined?'':String(v.filters.minAmountMinor),maxAmountMinor:v.filters.maxAmountMinor===undefined?'':String(v.filters.maxAmountMinor)}});
    }}><option value="">Open a saved view</option>{prefs?.savedViews.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
      <form onSubmit={saveView}><input aria-label="Saved view name" placeholder="Name this view" required maxLength={80} value={saveName} onChange={e=>setSaveName(e.target.value)}/><button className="button secondary" disabled={busy||!prefs||prefs.savedViews.length>=30&&!prefs.savedViews.some(v=>v.name.toLowerCase()===saveName.trim().toLowerCase())}>{busy?'Saving…':'Save view'}</button></form>
      {!!prefs?.savedViews.length&&<details><summary>Manage views</summary><div>{prefs.savedViews.map(v=><p key={v.id}>{v.name}<button className="text-button" disabled={busy} aria-label={`Delete view ${v.name}`} onClick={()=>void savePreferences({...prefs,savedViews:prefs.savedViews.filter(x=>x.id!==v.id)})}>Delete</button></p>)}</div></details>}
    </div>
    {error&&<p className="form-message error" role="alert">{error} <button className="text-button" onClick={()=>{setError('');setRetry(v=>v+1);}}>Reload views</button></p>}
    {!!checked.length&&<p className="selection-hint">{checked.length} selected on this page. <button className="text-button" onClick={clearChecked}>Clear selection</button></p>}
    {bulk&&<BulkEditor ids={checked} categories={categories} close={()=>setBulk(false)} saved={message=>{setBulk(false);changed(message);}}/>}
    {transfer&&<TransferDialog mode={transfer} profile={profile} close={()=>setTransfer(null)} changed={message=>{setTransfer(null);changed(message);}}/>}
  </div>;
}
function BulkEditor({ids,categories,close,saved}:{ids:string[];categories:Category[];close:()=>void;saved:(message:string)=>void}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');const attempt=useRef<SubmissionAttempt|null>(null);
  async function submit(event:React.FormEvent<HTMLFormElement>) {
    event.preventDefault();if(busy)return;const form=new FormData(event.currentTarget);
    const categoryId=String(form.get('category')),state=String(form.get('state'));
    if(!categoryId&&!state){setError('Choose a category or ownership state to change.');return;}
    const body=JSON.stringify({ids,changes:{...(categoryId?{categoryId}:{}),...(state?{state}:{})}});attempt.current=getSubmissionAttempt(attempt.current,'/collection/bulk',body);setBusy(true);setError('');
    try{await api('/collection/bulk',{method:'PATCH',body,headers:{'Idempotency-Key':attempt.current.key}});attempt.current=null;saved(`${ids.length} items were updated.`);}catch(err){setError(errorMessage(err));setBusy(false);}
  }
  return <Dialog title={`Edit ${ids.length} selected items`} close={close} busy={busy}><p className="field-help">Purchase history stays unchanged. Ownership changes do not record refunds or sale proceeds.</p><form className="item-form" onSubmit={submit}><fieldset disabled={busy}><label className="field">Category<select aria-label="Category" name="category"><option value="">No change</option>{categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label className="field">Ownership state<select aria-label="Ownership state" name="state"><option value="">No change</option><option value="owned">Owned</option><option value="sold">Sold</option><option value="returned">Returned</option><option value="donated">Donated</option></select></label></fieldset>{error&&<p role="alert" className="form-message error">{error}</p>}<div className="dialog-actions"><button className="button secondary" type="button" disabled={busy} onClick={close}>Cancel</button><button className="button primary" disabled={busy}>{busy?'Applying…':'Apply changes'}</button></div></form></Dialog>;
}
