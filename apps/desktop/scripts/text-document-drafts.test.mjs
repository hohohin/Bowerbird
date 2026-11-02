import assert from 'node:assert/strict';
import test from 'node:test';
import { getTextDocumentDraft, keepTextDocumentDraft, acceptTextDocumentSave, finishTextDocumentSave, subscribeTextDocumentDraft } from '../src/lib/textDocumentDrafts.ts';
const base = {assetId:'a',path:'C:/a.md',text:'original',version:'v1',format:'markdown'};
test('separate drafts survive editor unmount and keep their opened version', () => {
  keepTextDocumentDraft('a',{base,text:'unsaved',mode:'source'});
  keepTextDocumentDraft('b',{base:{...base,assetId:'b'},text:'second',mode:'body'});
  assert.equal(getTextDocumentDraft('a').text,'unsaved');
  assert.equal(getTextDocumentDraft('a').base.version,'v1');
  assert.equal(getTextDocumentDraft('b').text,'second');
});
test('save response does not overwrite text entered while saving', () => {
  const current = {base,text:'newer edit',mode:'source'};
  const next = acceptTextDocumentSave(current,'submitted',{...base,text:'submitted',version:'v2'});
  assert.equal(next.text,'newer edit'); assert.equal(next.base.version,'v2');
  keepTextDocumentDraft('a', next); assert.equal(getTextDocumentDraft('a').text,'newer edit');
});
test('saving unchanged submitted text accepts normalized native text and clears pending draft', () => {
  const next = acceptTextDocumentSave({base,text:'submitted\n',mode:'body'},'submitted\n',{...base,text:'submitted\r\n',version:'v2'});
  assert.equal(next.text,'submitted\r\n'); keepTextDocumentDraft('a',next);
  assert.equal(getTextDocumentDraft('a'),undefined);
});
test('completion after unmount updates the reopened session and preserves newer editing', () => {
  const submitted = {base,text:'submitted',mode:'body'};
  keepTextDocumentDraft('race', {base,text:'edited in reopened session',mode:'source'});
  let received;
  const stop = subscribeTextDocumentDraft('race', next => {received=next;});
  finishTextDocumentSave('race',submitted,{...base,text:'submitted',version:'v2'});
  assert.equal(getTextDocumentDraft('race').text,'edited in reopened session');
  assert.equal(getTextDocumentDraft('race').base.version,'v2');
  assert.equal(received.text,'edited in reopened session'); stop();
});
test('an older save result cannot overwrite a newer disk base', () => {
  const submitted = {base,text:'old submission',mode:'body'};
  keepTextDocumentDraft('ordered',{base:{...base,version:'v3',text:'new disk'},text:'new edit',mode:'body'});
  finishTextDocumentSave('ordered',submitted,{...base,version:'v2',text:'old submission'});
  assert.equal(getTextDocumentDraft('ordered').base.version,'v3');
});
test('a reopened clean document with a newer version rejects a late older completion', () => {
  const submitted = {base,text:'old submission',mode:'body'};
  const fresh = {base:{...base,version:'v3',text:'fresh disk'},text:'fresh disk',mode:'body'};
  keepTextDocumentDraft('clean-reopened',fresh);
  assert.equal(finishTextDocumentSave('clean-reopened',submitted,{...base,version:'v2',text:'old submission'}), undefined);
});
