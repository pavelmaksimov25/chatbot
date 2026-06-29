import { Composer } from './chat/Composer';
import { ConversationList } from './chat/ConversationList';
import { MessageList } from './chat/MessageList';
import { SuggestionChips } from './chat/SuggestionChips';
import { useChat } from './chat/useChat';

export function Chat({ csrfToken }: { csrfToken: string }) {
  const chat = useChat(csrfToken);

  return (
    <div style={{ display: 'flex', gap: '2rem', alignItems: 'flex-start' }}>
      <ConversationList
        conversations={chat.conversations}
        activeId={chat.activeId}
        streaming={chat.streaming}
        onNew={chat.startWelcomeChat}
        onOpen={chat.openConversation}
        onDelete={chat.removeConversation}
      />

      <section aria-label="Chat" style={{ flex: 1 }}>
        <MessageList
          messages={chat.messages}
          streaming={chat.streaming}
          onEdit={chat.startEditing}
        />
        <SuggestionChips chips={chat.chips} streaming={chat.streaming} onSelect={chat.send} />
        {chat.error && <p role="alert">{chat.error}</p>}
        <Composer
          input={chat.input}
          streaming={chat.streaming}
          attaching={chat.attaching}
          editing={chat.editing !== null}
          attachment={chat.attachment}
          attachInputRef={chat.attachInputRef}
          onInputChange={chat.setInput}
          onSubmit={chat.send}
          onAttach={chat.attachFile}
          onRemoveAttachment={chat.clearAttachment}
          onCancelEdit={chat.cancelEditing}
        />
      </section>
    </div>
  );
}
