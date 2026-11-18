function allRefs(model) {
  const starts = model.startLoad.parts.flatMap(part => [
    { ...part, verb: 'Start', location: part.name },
    ...(part.items || []).map(item => ({ ...item, verb: 'Start', location: item.name }))
  ]);
  const reads = model.reads.flatMap(read => {
    if ((read.files || []).length <= 1) {
      const file = read.files?.[0];
      return [{ ...read, ref: file?.ref || read.ref, verb: read.tool || 'Read', location: file?.path || read.location }];
    }
    return read.files.map(file => ({
      ...file,
      verb: read.tool || 'Read',
      location: file.path || file.name
    }));
  });
  return [...starts, ...reads];
}

function refList(model) {
  return allRefs(model).map(item => `${item.ref}  ${item.verb || 'Start'}  ${item.location || item.name}`).join('\n');
}

const rules = `For each source, give its ref and an exact quote copied character for character.
If no read contains the answer and you inferred it, say "inferred" and cite what you inferred it from.
Use at most 5 citations.
Answer only with JSON:
{"summary": string, "citations": [{"ref": string, "quote": string, "kind": "copied" | "inferred", "explanation": string}]}`;

export function buildAskPrompt(model, body) {
  if (body.kind === 'tool') {
    const tool = model.conversation.flatMap(item => item.tools || []).find(item => item.id === body.toolUseId);
    if (!tool) throw new Error('Tool call was not found.');
    const input = JSON.stringify(tool.input).slice(0, 1500);
    return `You are a fork of this session. Do not change files.
The user asks why you made this tool call:
Tool: ${tool.verb}
Tool use id: ${tool.id}
Input: ${input}
Question: ${body.question}

${rules}

Refs:
${refList(model)}`;
  }
  const message = model.conversation.find(item => item.messageIndex === body.messageIndex && item.role === 'assistant');
  return `You are a fork of this session. Do not change files.
The user selected this text from your answer:
"""${body.text || ''}"""
Question: ${body.question}
The assistant message starts with:
"""${String(message?.text || '').slice(0, 300)}"""

${rules}

Refs:
${refList(model)}`;
}
