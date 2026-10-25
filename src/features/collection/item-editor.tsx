'use client';
import { useRef, useState } from 'react';
import { TagPicker } from '@/features/tags/tag-controls';
import { Dialog } from '@/components/dialog';
import { api, errorMessage } from '@/lib/api';
import { getSubmissionAttempt, type SubmissionAttempt } from '@/shared/submission';
import { parsePrice, type Category, type Profile } from '@/shared/collection';
import type { items } from '@/server/db/schema';
type Item = typeof items.$inferSelect;
type EntryKind = 'purchase' | 'owned' | 'expense';
export type SavedEntry = { kind: EntryKind | 'edit'; occurredOn: string };
export function ItemEditor({categories,profile,categoryId,source,recentCategoryIds=[],mode='create',initialEntry='purchase',close,saved}:{categories:Category[];profile:Profile;categoryId:string;source?:Item;recentCategoryIds?:string[];mode?:'create'|'edit'|'duplicate';initialEntry?:EntryKind;close:()=>void;saved:(name:string,another:boolean,entry:SavedEntry)=>void}) {
  const [entry,setEntry]=useState<EntryKind>(mode==='create'?initialEntry:'owned');
  const purchase=entry!=='owned', expense=entry==='expense';
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[generation,setGeneration]=useState(0),[recent,setRecent]=useState(source?.categoryId || categoryId || categories[0]?.id || '');
  const [tags,setTags]=useState<string[]>([]),[pendingTags,setPendingTags]=useState(false);
  const attempt=useRef<SubmissionAttempt|null>(null);
  const recentOptions=recentCategoryIds.flatMap(id=>categories.find(c=>c.id===id)??[]);
  const otherOptions=categories.filter(c=>!recentCategoryIds.includes(c.id));
  const editing=mode==='edit';
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:profile.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  function changeEntry(next:EntryKind) {
    if(next===entry)return;
    // Changing entry type remounts the fieldset and discards the picker's draft.
    setEntry(next);setPendingTags(false);setError('');
  }
  async function submit(event:React.FormEvent<HTMLFormElement>) {
    event.preventDefault();if(busy)return;
    if(!editing&&!expense&&pendingTags){setError('Select or create the tag before saving.');return;}
    const formElement=event.currentTarget,form=new FormData(formElement);
    const name=String(form.get('name')).trim(), categoryId=String(form.get('category'));
    const note=String(form.get('note')||'').trim()||null;
    const amountMinor=parsePrice(String(form.get('price')||''));
    if(!editing && purchase && amountMinor===null) {setError('Enter a price greater than zero, with up to two decimal places.');return;}
    const payload=editing?{name,categoryId,acquiredOn:String(form.get('date')||'')||null,description:note,...(source?.state==='wishlist'?{}:{state:String(form.get('state'))})}:purchase?{name,categoryId,amountMinor,currency:profile.currency,occurredOn:String(form.get('date')),merchant:String(form.get('merchant')||'').trim()||null,note}:{name,categoryId,acquiredOn:String(form.get('date')||'')||null,description:note};
    const path=editing?`/items/${source!.id}`:expense?'/expenses':purchase?'/purchases':'/items';
    const body=JSON.stringify(editing?payload:{...payload,...(!expense&&tags.length?{tags}:{})});attempt.current=getSubmissionAttempt(attempt.current,path,body);
    setBusy(true);setError('');
    try {
      await api(path,{method:editing?'PATCH':'POST',body,headers:{'Idempotency-Key':attempt.current.key}});
      attempt.current=null;setRecent(categoryId);
      const another=!editing&&form.get('another')==='on';
      if(another) {setTags([]);setPendingTags(false);setGeneration(v=>v+1);setBusy(false);}
      saved(name,another,{kind:editing?'edit':entry,occurredOn:String(form.get('date')||'')});
    } catch(err) {setError(errorMessage(err));setBusy(false);}
  }
  return <Dialog title={editing?'Edit item':mode==='duplicate'?'Duplicate item':expense?'Add purchase':'Add to your collection'} close={close} busy={busy}>
    {!editing&&<><div className="segmented" aria-label="Entry type">
      <button aria-pressed={entry==='purchase'} disabled={busy} onClick={()=>changeEntry('purchase')}>New purchase</button>
      <button aria-pressed={entry==='owned'} disabled={busy} onClick={()=>changeEntry('owned')}>Already owned</button>
      <button aria-pressed={expense} disabled={busy} onClick={()=>changeEntry('expense')}>Purchase only</button>
    </div><p className="field-help">{expense?'Record spending for groceries, meals, or other purchases without adding an item to your collection.':mode==='duplicate'?'Copies item details. A new expense is recorded only if you choose New purchase.':purchase?'Record an item and its purchase together.':'Add something you own without recording new spending.'}</p></> }
    {editing&&<p className="field-help">Changes apply to the item. Purchase amounts, dates, and spending categories remain in your history.</p>}
    <form onSubmit={submit} className="item-form"><fieldset disabled={busy} key={`${entry}:${generation}`}>
      <label className="field">{expense?'Purchase name':'Item name'}<input name="name" required maxLength={200} autoFocus defaultValue={generation? '':source?.name??''} placeholder={expense?'e.g. Weekly groceries':'e.g. Everyday headphones'} /></label>
      <label className="field">Category<select aria-label="Category" name="category" required defaultValue={recent}>{recentOptions.length>0&&<optgroup label="Recently used">{recentOptions.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>}<optgroup label="All categories">{otherOptions.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</optgroup></select></label>
      <div className="form-row">{!editing&&purchase&&<label className="field">Price ({profile.currency})<input name="price" required inputMode="decimal" placeholder="0.00" maxLength={13}/></label>}<label className="field">{!editing&&purchase?'Purchase date':'Acquired on (optional)'}<input name="date" type="date" min="1900-01-01" required={!editing&&purchase} defaultValue={editing?source?.acquiredOn??'':purchase?today:''}/></label></div>
      {editing&&source?.state!=='wishlist'&&<label className="field">Ownership state<select aria-label="Ownership state" name="state" defaultValue={source?.state??'owned'}><option value="owned">Owned</option><option value="sold">Sold</option><option value="returned">Returned</option><option value="donated">Donated</option></select></label>}
      {!editing&&purchase&&<label className="field">Store (optional)<input name="merchant" maxLength={200}/></label>}
      <label className="field">Notes (optional)<textarea name="note" maxLength={5000} rows={3} defaultValue={generation?'':source?.description??''}/></label>
      {!editing&&!expense&&<TagPicker key={`tags:${generation}`} value={tags} onChange={setTags} disabled={busy} pendingChanged={setPendingTags}/>}
      {!editing&&<label className="check-field"><input type="checkbox" name="another"/> Add another after saving</label>}
    </fieldset>{error&&<p className="form-message error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="button secondary" disabled={busy} onClick={close}>Cancel</button><button className="button primary" disabled={busy}>{busy?'Saving…':editing?'Save changes':expense?'Add purchase':'Add item'}</button></div></form>
  </Dialog>;
}
