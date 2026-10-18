const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const {buildSync}=require('esbuild');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-email-preview-'));
buildSync({entryPoints:['src/renderer/components/assistant-workspace/NativeEmailPreview.tsx'],bundle:true,platform:'node',format:'cjs',jsx:'automatic',outfile:path.join(directory,'preview.cjs')});
const {EmailRecipientReview,EmailContentReview}=require(path.join(directory,'preview.cjs'));
after(()=>fs.rmSync(directory,{recursive:true,force:true}));
const draft={id:'draft',contactId:5,email:'client@example.test',subject:'TEST <subject>',text:'TEST <script>never execute</script>',html:'',attachments:[],recipients:{to:[{email:'client@example.test',source:'contact',contactId:5}],cc:[{email:'support@example.test',source:'support_contact',supportContact:{planId:'plan',id:'support'}}],bcc:[{email:'owner@example.test',source:'owner_provided'}]}};
test('exact preview renders all To/CC/BCC destinations and provenance, including hidden-copy recipients',()=>{
 const output=renderToStaticMarkup(React.createElement(EmailRecipientReview,{draft}));
 for(const value of ['To','CC','BCC','client@example.test','support@example.test','owner@example.test','saved contact #5','configured plan support','address provided for this message'])assert.ok(output.toLowerCase().includes(value.toLowerCase()),value);
 const malicious={...draft,recipients:{...draft.recipients,to:[{email:'safe@example.test',name:'<script>unsafe</script>',source:'owner_provided'}]}};
 const safe=renderToStaticMarkup(React.createElement(EmailRecipientReview,{draft:malicious}));assert.equal(safe.includes('<script>unsafe'),false);assert.ok(safe.includes('&lt;script&gt;unsafe'));
});
test('plain text stays inert and HTML previews retain isolated origin, inert links and external-resource restrictions',()=>{
 const plain=renderToStaticMarkup(React.createElement(EmailContentReview,{draft}));assert.ok(plain.includes('&lt;script&gt;never execute'));assert.equal(plain.includes('<script>never execute'),false);
 const html=renderToStaticMarkup(React.createElement(EmailContentReview,{draft:{...draft,html:'<p>TEST HTML <a href="https://example.test/path">visible destination</a></p>'}}));assert.ok(html.includes('sandbox=""'));assert.ok(html.includes('referrerPolicy="no-referrer"'));assert.ok(html.includes('default-src &#x27;none&#x27;'));assert.ok(html.includes('navigate-to &#x27;none&#x27;'));assert.ok(html.includes('visible destination'));assert.equal(/href(?:=|&#x3D;)/i.test(html),false);assert.ok(html.includes('Plain text alternative'));
});
