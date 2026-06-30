import type { ConversationItem } from './types';

interface Props {
  conversations: ConversationItem[];
  activeId: string | null;
  streaming: boolean;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}

export function ConversationList({
  conversations,
  activeId,
  streaming,
  onNew,
  onOpen,
  onDelete,
}: Props) {
  return (
    <nav aria-label="Conversations">
      <button onClick={onNew} disabled={streaming}>
        New chat
      </button>
      <ul>
        {conversations.map((conversation) => (
          <li key={conversation.id}>
            <button
              onClick={() => onOpen(conversation.id)}
              disabled={streaming}
              aria-current={conversation.id === activeId ? 'true' : undefined}
            >
              {conversation.title ?? conversation.preview ?? 'New conversation'}
            </button>{' '}
            <button
              aria-label={`Delete conversation ${conversation.title ?? conversation.preview ?? conversation.id}`}
              onClick={() => onDelete(conversation.id)}
              disabled={streaming}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
