// Expo config plugin: turn on automatic signing for the app target so xcodebuild (and
// therefore `expo run:ios --device`) can create the development provisioning profile for
// this team instead of failing with "No profiles for 'edu.steelhacks.aisle' were found".
// Team comes from expo.ios.appleTeamId (app.json).
const { withXcodeProject } = require('expo/config-plugins');

module.exports = (config) =>
  withXcodeProject(config, (cfg) => {
    const team = cfg.ios && cfg.ios.appleTeamId;
    if (!team) return cfg;
    const project = cfg.modResults;
    const targetUuid = project.getFirstTarget().uuid;
    const configs = project.pbxXCBuildConfigurationSection();
    const targetConfigList = project.pbxXCConfigurationList()[project.getFirstTarget().firstTarget.buildConfigurationList];
    const ids = new Set((targetConfigList.buildConfigurations || []).map((c) => c.value));
    for (const [id, cfgObj] of Object.entries(configs)) {
      if (!ids.has(id) || !cfgObj || typeof cfgObj !== 'object' || !cfgObj.buildSettings) continue;
      const bs = cfgObj.buildSettings;
      bs.CODE_SIGN_STYLE = 'Automatic';
      bs.DEVELOPMENT_TEAM = team;
      // Keys with brackets must be quoted in the pbxproj or the parser rejects the file.
      delete bs['CODE_SIGN_IDENTITY[sdk=iphoneos*]'];
      bs['"CODE_SIGN_IDENTITY[sdk=iphoneos*]"'] = '"Apple Development"';
      delete bs.PROVISIONING_PROFILE_SPECIFIER;
    }
    // The project-level attribute Xcode's UI toggles.
    const attrs = project.getFirstProject().firstProject.attributes || {};
    attrs.TargetAttributes = attrs.TargetAttributes || {};
    attrs.TargetAttributes[targetUuid] = { ...(attrs.TargetAttributes[targetUuid] || {}), DevelopmentTeam: team, ProvisioningStyle: 'Automatic' };
    project.getFirstProject().firstProject.attributes = attrs;
    return cfg;
  });
