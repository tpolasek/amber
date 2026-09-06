import type { AvailableModel } from "./client-types.js";
import type { ThinkingLevel } from "./thinking-level.js";

export function settingsTextField(
  label: string,
  value: string,
  placeholder: string,
  onInput: (value: string) => void,
  options: { type?: "text" | "password"; disabled?: boolean; onChangeOnly?: boolean } = {},
): HTMLLabelElement {
  const field = settingsField(label);
  const input = document.createElement("input");
  input.type = options.type ?? "text";
  input.value = value;
  input.placeholder = placeholder;
  input.disabled = options.disabled === true;
  if (options.disabled) input.dataset.permanentlyDisabled = "true";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.addEventListener(options.onChangeOnly ? "change" : "input", () => onInput(input.value));
  field.append(input);
  return field;
}

export function settingsTextAreaField(
  label: string,
  value: string,
  placeholder: string,
  onInput: (value: string) => void,
): HTMLLabelElement {
  const field = settingsField(label);
  field.classList.add("wide");
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.placeholder = placeholder;
  textarea.spellcheck = true;
  textarea.addEventListener("input", () => onInput(textarea.value));
  field.append(textarea);
  return field;
}

export function settingsSelectField(
  label: string,
  value: string,
  options: Array<{ value: string; label: string }>,
  onChange: (value: string) => void,
): HTMLLabelElement {
  const field = settingsField(label);
  const select = document.createElement("select");
  for (const option of options) {
    const item = document.createElement("option");
    item.value = option.value;
    item.textContent = option.label;
    item.selected = option.value === value;
    select.append(item);
  }
  select.addEventListener("change", () => onChange(select.value));
  field.append(select);
  return field;
}

export function settingsThinkingField(
  label: string,
  value: ThinkingLevel | undefined,
  onChange: (value: string) => void,
  emptyLabel = "Provider default",
): HTMLLabelElement {
  return settingsSelectField(label, value ?? "", [
    { value: "", label: emptyLabel },
    ...(["none", "low", "medium", "high", "xhigh", "max"] as ThinkingLevel[])
      .map((level) => ({ value: level, label: level.toUpperCase() })),
  ], onChange);
}

export function settingsNumberField(
  label: string,
  value: number | undefined,
  placeholder: string,
  onInput: (value: string) => void,
): HTMLLabelElement {
  const field = settingsField(label);
  const input = document.createElement("input");
  input.type = "number";
  input.min = "1";
  input.step = "1";
  input.value = value === undefined ? "" : String(value);
  input.placeholder = placeholder;
  input.addEventListener("input", () => onInput(input.value));
  field.append(input);
  return field;
}

export function settingsReadOnlyField(label: string, value: string): HTMLLabelElement {
  const field = settingsField(label);
  const output = document.createElement("span");
  output.className = "settings-readonly-value";
  output.textContent = value;
  field.append(output);
  return field;
}

export function settingsField(label: string): HTMLLabelElement {
  const field = document.createElement("label");
  field.className = "settings-field";
  const title = document.createElement("span");
  title.textContent = label;
  field.append(title);
  return field;
}

export function settingsCheckboxField(label: string, checked: boolean, onChange: (checked: boolean) => void): HTMLLabelElement {
  const field = document.createElement("label");
  field.className = "settings-checkbox";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  const text = document.createElement("span");
  text.textContent = label;
  input.addEventListener("change", () => onChange(input.checked));
  field.append(input, text);
  return field;
}

export function settingsRemoveButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "settings-remove-button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.textContent = "×";
  button.addEventListener("click", onClick);
  return button;
}

export function settingsEmptyState(message: string): HTMLElement {
  const empty = document.createElement("p");
  empty.className = "settings-empty";
  empty.textContent = message;
  return empty;
}

export function settingsModelSelectionField(options: {
  label: string;
  value: string | undefined;
  models: AvailableModel[];
  emptyLabel: string;
  placeholder: string;
  optionValue: (model: AvailableModel) => string;
  optionLabel: (model: AvailableModel) => string;
  onChange: (value: string) => void;
}): HTMLLabelElement {
  const update = (nextValue: string): void => {
    options.onChange(nextValue);
  };
  if (options.models.length === 0) {
    return settingsTextField(options.label, options.value ?? "", options.placeholder, update);
  }
  const choices = [{ value: "", label: options.emptyLabel }];
  if (options.value && !options.models.some((model) => options.optionValue(model) === options.value)) {
    choices.push({ value: options.value, label: `${options.value} (not currently loaded)` });
  }
  choices.push(...options.models.map((model) => ({
    value: options.optionValue(model),
    label: options.optionLabel(model),
  })));
  return settingsSelectField(options.label, options.value ?? "", choices, update);
}

export function settingsUnqualifiedModelLabel(model: AvailableModel): string {
  return model.displayName.toLocaleLowerCase() === model.model.toLocaleLowerCase()
    ? model.displayName
    : `${model.displayName} · ${model.model}`;
}
