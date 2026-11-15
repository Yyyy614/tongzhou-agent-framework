import React from 'react';
import {readableText} from '../../../client/web/result-view.mjs';

/** Readable model text without HTML execution, remote links or hidden source IDs. */
export function WorkResult({value,source=false}){
    const original=typeof value==='string'?value:'';
    return <div className="cw-result">{(source?original:readableText(original)).split('\n').filter(line=>line.trim()).map((line,i)=>{
        const heading=/^#{1,4}\s/u.test(line),content=line.replace(/^#{1,4}\s/u,'').replace(/^[-*]\s/u,'• ');
        const pieces=content.split(/(\*\*[^*]+\*\*|`[^`]+`)/gu).map((s,j)=>s.startsWith('**')?<strong key={j}>{s.slice(2,-2)}</strong>:s.startsWith('`')?<code key={j}>{s.slice(1,-1)}</code>:s);
        return heading?<h3 key={i}>{pieces}</h3>:<p key={i}>{pieces}</p>;
    })}</div>;
}
