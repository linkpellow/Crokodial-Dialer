import type { ReactNode } from 'react';

type OpenPlan = (planId: string) => void;

const tokenPattern = /(⟦plan:[^|⟧]+\|[^⟧]+⟧|\*\*[^*\n]+\*\*|`[^`\n]+`)/g;

function inline(text: string, openPlan: OpenPlan): ReactNode[] {
  return text.split(tokenPattern).map((part, index) => {
    const plan = /^⟦plan:([^|⟧]+)\|([^⟧]+)⟧$/.exec(part);
    if (plan) return <button className="assistant-plan-link" key={index} title="Open source brochure" onClick={() => openPlan(plan[1])}>{plan[2]}</button>;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    return part;
  });
}

function table(lines: string[], openPlan: OpenPlan, key: number) {
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(value => value.trim());
  const headings = cells(lines[0]), rows = lines.slice(2).map(cells);
  return <div className="assistant-table-wrap" key={key}><table><thead><tr>{headings.map((value, index) => <th key={index}>{inline(value, openPlan)}</th>)}</tr></thead>
    <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headings.map((_, column) => <td key={column}>{inline(row[column] ?? '', openPlan)}</td>)}</tr>)}</tbody></table></div>;
}

/** Safe, small Markdown surface. It never interprets HTML or creates arbitrary links. */
export function AssistantRichText({ text, openPlan }: { text: string; openPlan: OpenPlan }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n'), blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    if (/^```/.test(line.trim())) {
      const language = line.trim().slice(3).trim(), code: string[] = [];
      index++;
      while (index < lines.length && !/^```/.test(lines[index].trim())) code.push(lines[index++]);
      if (index < lines.length) index++;
      blocks.push(<pre key={blocks.length} data-language={language || undefined}><code>{code.join('\n')}</code></pre>);
      continue;
    }
    if (index + 1 < lines.length && lines[index].includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) {
      const group = [lines[index], lines[index + 1]]; index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) group.push(lines[index++]);
      blocks.push(table(group, openPlan, blocks.length));
      continue;
    }
    const unordered = /^\s*[-*]\s+(.+)$/.exec(line), ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      const entries: string[] = [], expression = unordered ? /^\s*[-*]\s+(.+)$/ : /^\s*\d+[.)]\s+(.+)$/;
      while (index < lines.length) { const match = expression.exec(lines[index]); if (!match) break; entries.push(match[1]); index++; }
      const List = unordered ? 'ul' : 'ol';
      blocks.push(<List key={blocks.length}>{entries.map((entry, item) => <li key={item}>{inline(entry, openPlan)}</li>)}</List>);
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const Heading = `h${Math.min(heading[1].length + 2, 5)}` as 'h3' | 'h4' | 'h5';
      blocks.push(<Heading key={blocks.length}>{inline(heading[2], openPlan)}</Heading>); index++; continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ''));
      blocks.push(<blockquote key={blocks.length}>{quote.map((value, row) => <span key={row}>{inline(value, openPlan)}{row < quote.length - 1 && <br/>}</span>)}</blockquote>);
      continue;
    }
    const paragraph: string[] = [line]; index++;
    while (index < lines.length && lines[index].trim() && !/^```|^\s*[-*]\s+|^\s*\d+[.)]\s+|^#{1,3}\s+|^>\s?/.test(lines[index]) && !(index + 1 < lines.length && lines[index].includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1]))) paragraph.push(lines[index++]);
    blocks.push(<p key={blocks.length}>{paragraph.map((value, row) => <span key={row}>{inline(value, openPlan)}{row < paragraph.length - 1 && <br/>}</span>)}</p>);
  }
  return <>{blocks}</>;
}
