// This team and bundle identifier define the distribution identity across updates.
export const MACOS_TEAM_ID = '2RZUB2TKD6';
export const MACOS_APP_IDENTIFIER = 'studio.a7e7.cuereview';

export function selectSigningIdentity(output, requestedIdentity = '') {
  const identities = [...new Map([...output.matchAll(/^\s*\d+\) ([A-Fa-f0-9]{40}) "([^"\r\n]+)"\s*$/gm)]
    .map(([, hash, name]) => [hash.toUpperCase(), { hash: hash.toUpperCase(), name }])).values()];
  const eligible = identity => identity.name.startsWith('Developer ID Application: ') && identity.name.endsWith(` (${MACOS_TEAM_ID})`);
  const requested = requestedIdentity.trim();
  if (requested === '-') throw new Error('Ad-hoc macOS packages cannot preserve update permissions. Use a Developer ID Application identity.');
  if (requested) {
    const matches = identities.filter(identity => identity.name === requested || identity.hash === requested.toUpperCase());
    if (matches.length === 0) throw new Error('APPLE_SIGNING_IDENTITY is not available in the selected keychain. Import its certificate and private key before packaging.');
    if (matches.length !== 1) throw new Error('APPLE_SIGNING_IDENTITY matches multiple identities; select its exact certificate SHA-1.');
    if (!eligible(matches[0])) throw new Error(`APPLE_SIGNING_IDENTITY must be a Developer ID Application identity for team ${MACOS_TEAM_ID}.`);
    return matches[0];
  }
  const matching = identities.filter(eligible);
  if (matching.length === 0) throw new Error(`No Developer ID Application identity for team ${MACOS_TEAM_ID} is available. Import the certificate and private key before packaging; ad-hoc fallback is disabled.`);
  if (matching.length > 1) throw new Error('Multiple matching Developer ID Application identities are available; set APPLE_SIGNING_IDENTITY to an exact name or certificate SHA-1.');
  return matching[0];
}

// This is a verification requirement, not a replacement for Apple's generated DR.
export function developerIdRequirement(identifier) {
  return `=identifier ${JSON.stringify(identifier)} and anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${MACOS_TEAM_ID}"`;
}

export function assertDeveloperIdSignature(signature, identifier) {
  if (/^Signature=adhoc$/m.test(signature) || /\bflags=[^\n]*\badhoc\b/.test(signature)) throw new Error('Packaged macOS code must not use an ad-hoc signature.');
  if (!signature.split(/\r?\n/).includes(`TeamIdentifier=${MACOS_TEAM_ID}`)) throw new Error(`Packaged macOS code must use signing team ${MACOS_TEAM_ID}.`);
  if (!signature.split(/\r?\n/).includes(`Identifier=${identifier}`)) throw new Error(`Packaged macOS code must retain identifier ${identifier}.`);
  if (!/^Authority=Developer ID Application: /m.test(signature)) throw new Error('Packaged macOS code must use a Developer ID Application certificate.');
  if (!/\bflags=[^\n]*\bruntime\b/.test(signature)) throw new Error('Packaged macOS code must retain the hardened runtime.');
  if (!/^Timestamp=.+$/m.test(signature)) throw new Error('Packaged macOS code must include a secure timestamp.');
}
