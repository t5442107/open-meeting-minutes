const toSimplifiedChinese = require('opencc-js').Converter({ from: 't', to: 'cn' });

function simplifyChinese(value) {
  return typeof value === 'string' ? toSimplifiedChinese(value) : value;
}

function simplifyMeetingNotes(generated) {
  return {
    ...generated,
    summary: simplifyChinese(generated.summary),
    minutes: simplifyChinese(generated.minutes),
    highlights: generated.highlights.map(simplifyChinese),
    todos: generated.todos.map(todo => ({
      ...todo,
      title: simplifyChinese(todo.title),
      owner: simplifyChinese(todo.owner),
      due: simplifyChinese(todo.due),
    })),
  };
}

module.exports = { simplifyChinese, simplifyMeetingNotes };
