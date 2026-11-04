'use strict';

// Règles des fichiers de version Mojang (système, architecture, fonctionnalités) et chemins Maven.
const os = require('node:os');

function osName() {
  return { win32: 'windows', darwin: 'osx' }[process.platform] ?? 'linux';
}

function mojangArch() {
  return process.arch === 'ia32' ? 'x86' : process.arch;
}

/** Applique une liste de règles « allow / disallow » : la dernière règle qui correspond l'emporte. */
function ruleAllows(rules, features = {}) {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    let match = true;
    if (rule.os) {
      if (rule.os.name && rule.os.name !== osName()) match = false;
      if (rule.os.arch && rule.os.arch !== mojangArch()) match = false;
      if (rule.os.version) {
        try {
          if (!new RegExp(rule.os.version).test(os.release())) match = false;
        } catch {
          match = false;
        }
      }
    }
    if (rule.features) {
      for (const [key, value] of Object.entries(rule.features)) {
        if (Boolean(features[key]) !== value) match = false;
      }
    }
    if (match) allowed = rule.action === 'allow';
  }
  return allowed;
}

/** "groupe:artefact:version[:classifieur][@ext]" → ses morceaux. */
function parseMaven(name) {
  const [coords, ext = 'jar'] = name.split('@');
  const [group, artifact, version, classifier] = coords.split(':');
  return { group, artifact, version, classifier, ext };
}

function mavenPath(name) {
  const { group, artifact, version, classifier, ext } = parseMaven(name);
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext}`;
  return [...group.split('.'), artifact, version, file].join('/');
}

/**
 * Les fichiers de version listent les natives de toutes les architectures pour un même système
 * (ex. natives-windows et natives-windows-arm64) : on ne garde que celles de ce processeur.
 */
function nativeArchMatches(classifier) {
  if (!classifier || !classifier.startsWith('natives-')) return true;
  if (/-(arm64|aarch_64)$/.test(classifier)) return process.arch === 'arm64';
  if (/-x86$/.test(classifier)) return process.arch === 'ia32';
  return true;
}

module.exports = { osName, ruleAllows, parseMaven, mavenPath, nativeArchMatches };
