interface Props {
  chips: string[];
  streaming: boolean;
  onSelect: (chip: string) => void;
}

export function SuggestionChips({ chips, streaming, onSelect }: Props) {
  if (chips.length === 0) {
    return null;
  }
  return (
    <p aria-label="Suggestions">
      {chips.map((chip) => (
        <button key={chip} onClick={() => onSelect(chip)} disabled={streaming}>
          {chip}
        </button>
      ))}
    </p>
  );
}
