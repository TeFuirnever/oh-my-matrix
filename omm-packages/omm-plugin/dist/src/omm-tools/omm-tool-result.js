/** Coerce unknown input to a trimmed string or null. */
export function normalizeNullableText(value) {
    return typeof value === "string" && value.trim() !== "" ? value : null;
}
//# sourceMappingURL=omm-tool-result.js.map