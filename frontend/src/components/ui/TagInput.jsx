/**
 * TagInput — controlled component for entering multiple string tags.
 * Usage:
 *   <TagInput value={tags} onChange={setTags} placeholder="Add keyword…" />
 */
import { useState } from "react";
import { X } from "lucide-react";
import clsx from "clsx";

export default function TagInput({
  value = [],
  onChange,
  placeholder = "Add tag…",
  maxTags = 20,
  className,
}) {
  const [inputValue, setInputValue] = useState("");

  const addTag = (raw) => {
    const tag = raw.trim();
    if (!tag) return;
    if (value.includes(tag)) return;
    if (value.length >= maxTags) return;
    onChange([...value, tag]);
    setInputValue("");
  };

  const removeTag = (tag) => onChange(value.filter((t) => t !== tag));

  const handleKeyDown = (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(inputValue);
    } else if (e.key === "Backspace" && !inputValue && value.length) {
      removeTag(value[value.length - 1]);
    }
  };

  return (
    <div
      className={clsx(
        "flex flex-wrap gap-2 p-2 border border-gray-300 rounded-lg bg-white min-h-[44px] focus-within:ring-2 focus-within:ring-primary-500 focus-within:border-primary-500",
        className
      )}
    >
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary-100 text-primary-700 text-sm font-medium"
        >
          {tag}
          <button
            type="button"
            onClick={() => removeTag(tag)}
            className="hover:text-primary-900 focus:outline-none"
            aria-label={`Remove ${tag}`}
          >
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => addTag(inputValue)}
        placeholder={value.length === 0 ? placeholder : ""}
        className="flex-1 min-w-[120px] outline-none text-sm bg-transparent text-gray-800 placeholder-gray-400"
      />
    </div>
  );
}
