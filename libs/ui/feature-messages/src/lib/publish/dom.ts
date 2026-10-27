/** What a person typed or chose in the control that fired `event`. */
export function controlValue(event: Event): string {
  const target = event.target;
  return target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
    ? target.value
    : '';
}
