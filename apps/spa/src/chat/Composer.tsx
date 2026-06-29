import type { RefObject } from 'react';

interface Props {
  input: string;
  streaming: boolean;
  attaching: boolean;
  editing: boolean;
  attachment: { id: string; name: string } | null;
  attachInputRef: RefObject<HTMLInputElement | null>;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onAttach: (file: File) => void;
  onRemoveAttachment: () => void;
  onCancelEdit: () => void;
}

export function Composer({
  input,
  streaming,
  attaching,
  editing,
  attachment,
  attachInputRef,
  onInputChange,
  onSubmit,
  onAttach,
  onRemoveAttachment,
  onCancelEdit,
}: Props) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <label>
        Message{' '}
        <textarea
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          rows={3}
          maxLength={8000}
        />
      </label>{' '}
      <label>
        Attach{' '}
        <input
          ref={attachInputRef}
          type="file"
          accept=".txt,.md,.json,.pdf,image/*,text/*"
          disabled={streaming || attaching}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              onAttach(file);
            }
          }}
        />
      </label>{' '}
      {attachment && (
        <span>
          📎 {attachment.name}{' '}
          <button type="button" onClick={onRemoveAttachment}>
            Remove
          </button>
        </span>
      )}{' '}
      <button type="submit" disabled={streaming || attaching || input.trim().length === 0}>
        {streaming ? 'Answering…' : editing ? 'Save edit' : 'Send'}
      </button>
      {editing && (
        <button type="button" onClick={onCancelEdit}>
          Cancel edit
        </button>
      )}
    </form>
  );
}
