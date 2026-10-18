import { emailDraftPreview, type EmailDraftDetail } from '../../services/assistantWorkspaceTypes';
import { previewSurface } from './previewSurface';

export function EmailRecipientReview({draft}:{draft:EmailDraftDetail}) {
  const recipients=draft.recipients??{to:[{email:draft.email,source:draft.contactId?'contact' as const:'owner_provided' as const,...(draft.contactId?{contactId:draft.contactId}:{})}],cc:[],bcc:[]};
  return <div aria-label="Exact email recipients">{(['to','cc','bcc'] as const).map(kind=><div key={kind}><strong>{kind.toUpperCase()}:</strong> {recipients[kind].length?recipients[kind].map((recipient,index)=><span key={`${recipient.email}:${index}`}>{index?', ':''}{recipient.name?`${recipient.name} — `:''}{recipient.email} <small>({recipient.source==='contact'?`saved contact #${recipient.contactId}`:recipient.source==='support_contact'?'configured plan support':'address provided for this message'})</small></span>):<span>None</span>}</div>)}</div>;
}

export function EmailContentReview({draft}:{draft:EmailDraftDetail}) {
  return <>{draft.html?<iframe title={`Email preview ${draft.subject}`} sandbox="" referrerPolicy="no-referrer" srcDoc={emailDraftPreview(previewSurface(draft.html))} className="nativework-preview"/>:<pre className="nativework-prewrap">{draft.text}</pre>}{!!draft.html&&<details><summary>Plain text alternative</summary><pre className="nativework-prewrap">{draft.text}</pre></details>}<ul>{draft.attachments.map((item,index)=><li key={`${item.name}:${index}`}><a className="nativework-link" href={`data:${item.contentType};base64,${item.base64}`} download={item.name}>Download {item.name}</a> · {item.byteSize} bytes · SHA-256 {item.sha256}</li>)}</ul></>;
}
