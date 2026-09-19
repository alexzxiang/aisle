// Expo config plugin: bundle every CoreML model under <app>/models/ (plus its <name>.json
// manifest and manifest.json) as a resource of the app target. Xcode compiles .mlpackage →
// .mlmodelc at build time, so ModelRegistry.swift finds `<name>.mlmodelc` in Bundle.main.
//
// Why not the podspec: CocoaPods ignores resource patterns outside the pod root
// (modules/perception/ios), so `s.resources = ../../../models/…` was silently dropped.
// This plugin runs on every `expo prebuild`, so it survives --clean and EAS builds
// (.easignore uploads the git-ignored .mlpackage directories).
const { withXcodeProject, withDangerousMod, IOSConfig } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MODELS_DIR = 'models';

function listModelFiles(projectRoot) {
  const dir = path.join(projectRoot, MODELS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(mlpackage|mlmodelc|json)$/.test(f))
    .map((f) => path.join(dir, f));
}

function copyModelsIntoIos(projectRoot, platformProjectRoot) {
  const dest = path.join(platformProjectRoot, MODELS_DIR);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const abs of listModelFiles(projectRoot)) {
    fs.cpSync(abs, path.join(dest, path.basename(abs)), { recursive: true });
  }
}

const withCoreMLModels = (config) => {
  // Xcode resolves group-relative paths under ios/, so the models are copied there first.
  config = withDangerousMod(config, [
    'ios',
    async (cfg) => {
      copyModelsIntoIos(cfg.modRequest.projectRoot, cfg.modRequest.platformProjectRoot);
      return cfg;
    },
  ]);
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const files = listModelFiles(cfg.modRequest.projectRoot);
    if (files.length === 0) return cfg;
    const groupName = 'CoreMLModels';
    const targetUuid = project.getFirstTarget().uuid;
    // A dedicated group keeps the references tidy and idempotent across prebuilds.
    // The group's own path is `models` (relative to ios/), so each file is referenced by
    // basename and resolves to ios/models/<file>. (A group without a path serialises as
    // `path = undefined` and Xcode then looks in ios/undefined/.)
    let group = project.pbxGroupByName(groupName);
    if (!group) {
      const created = project.addPbxGroup([], groupName, MODELS_DIR, '"<group>"');
      const mainGroupKey = project.getFirstProject().firstProject.mainGroup;
      project.addToPbxGroup(created.uuid, mainGroupKey);
      group = project.pbxGroupByName(groupName);
    }
    for (const abs of files) {
      // Basename only: the CoreMLModels group already carries the `models` path.
      const rel = path.basename(abs);
      const already = Object.values(project.pbxFileReferenceSection()).some(
        (r) => r && typeof r === 'object' && String(r.path || '').replace(/"/g, '') === rel,
      );
      if (already) continue;
      IOSConfig.XcodeUtils.addResourceFileToGroup({
        filepath: rel,
        groupName,
        project,
        isBuildFile: true,
        verbose: false,
        targetUuid,
      });
    }
    return cfg;
  });
};

module.exports = withCoreMLModels;
