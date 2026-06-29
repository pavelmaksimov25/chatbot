import Markdown from 'react-markdown';
import type { ChatMessage } from './types';

interface Props {
  messages: ChatMessage[];
  streaming: boolean;
  onEdit: (message: ChatMessage) => void;
}

export function MessageList({ messages, streaming, onEdit }: Props) {
  return (
    <ol>
      {messages.map((message, i) => (
        <li key={message.id ?? i} data-role={message.role}>
          {message.role === 'assistant' ? (
            // react-markdown renders to React elements — model output is
            // never injected as raw HTML (CSP is the second net).
            <Markdown>{message.content}</Markdown>
          ) : (
            <p>
              {message.content}
              {message.attachments?.map((name, j) => (
                <span key={j}> 📎 {name}</span>
              ))}{' '}
              {message.id && (
                <button
                  aria-label={`Edit message ${message.content.slice(0, 40)}`}
                  onClick={() => onEdit(message)}
                  disabled={streaming}
                >
                  Edit
                </button>
              )}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
