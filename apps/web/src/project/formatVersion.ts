/**
 * An auto written in an older `formatVersion` opens migrated (`@horizon36596/zenith-schema`
 * `migrate`), and Save writes the current version. Opening one says so, because the file on disk
 * changes format on the next save, and an older Zenith cannot open the newer format.
 */
import { FORMAT_VERSIONS } from "@horizon36596/zenith-schema";

/**
 * The `formatVersion` an auto file's JSON was written at, as the `LoadedAuto` field, when it is older
 * than the one this build writes; nothing when it is current or cannot be read (the load itself says
 * what is wrong then).
 */
export function olderFormatOf(json: unknown): { fromFormatVersion?: number } {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return {};
  const version = (json as Record<string, unknown>)["formatVersion"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return {};
  return version < FORMAT_VERSIONS.auto ? { fromFormatVersion: version } : {};
}

/**
 * The status line when a host too old for this Zenith opens a project. The out-of-date sentence
 * comes first and already says Save to the host is off and Save a copy keeps the work; when the
 * auto that opened was written in an older format, a sentence after it says the host cannot open
 * the format Save writes, which the older-format notice the open replaced would have said.
 */
export function outdatedOpenLine(
  outdated: string,
  hostName: string,
  opened: { fileName: string; fromFormatVersion?: number } | null,
): string {
  if (opened === null || opened.fromFormatVersion === undefined) return outdated;
  const current = String(FORMAT_VERSIONS.auto);
  return (
    `${outdated} ${opened.fileName} was written in auto format ${String(opened.fromFormatVersion)}, ` +
    `and saving writes format ${current}, which this ${hostName} cannot open until it is updated.`
  );
}

/**
 * The status line for an auto that opened from an older format. In host mode with a host too old
 * for this Zenith (`HostView.outdated`), it also says that the host cannot open what Save would
 * write, so Save to it is off (sweep W4-6).
 */
export function olderFormatLine(
  fileName: string,
  fromFormatVersion: number,
  host?: { name: string; outdated: string | null } | null,
): string {
  const current = String(FORMAT_VERSIONS.auto);
  const line =
    `Opened ${fileName}, which an older Zenith wrote in auto format ${String(fromFormatVersion)}. ` +
    `Saving writes it in format ${current}, which older versions of Zenith cannot open.`;
  if (host === undefined || host === null || host.outdated === null) return line;
  return (
    `${line} This ${host.name} cannot open format ${current} until it is updated, so Save to ${host.name} is off. ` +
    `Save a copy keeps your work.`
  );
}
