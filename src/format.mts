// The data format: one number for the layout of every record the spider
// sends, which the extension that loads it owns and serves as data_format
// in the spider's config block. The spider stamps it on each record as
// format_version and builds it into each upload key (keys.mts), so when the
// number changes every thread in the crawl window is unsent under the new
// one and goes out once more. Format 1 is the layout this spider has always
// sent, and keeps the keys it always had, so a config without a number, or
// with one out of form, runs exactly as before.

const MAX_FORMAT = 999;

// A whole number from 1 to 999.
export function isDataFormat(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_FORMAT;
}

// The served data_format, or 1 when it is absent or out of form.
export function dataFormatOf(value: unknown): number {
  return isDataFormat(value) ? value : 1;
}
