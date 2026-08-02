// ============================================
// maestro-js: spectra-theme-loader.js
// ============================================
// Fetch the live VRGB theme from the Spectra endpoint and inject it into
// <style id="vrgb-tokens">. The live node is the single source of truth --
// no build-time snapshot, no static fallback. Shared verbatim across every
// surface (index / pipeline / monitor); each surface's own toggle owns the
// show/hide. Mirrors cue-vox (tools/cue-vox/templates/index.html).
//
// Classic script: runs in document order at its <head> position. String
// concatenation only -- no template literals (house rule).
(function () {
  'use strict';

  var THEME_NODE_ID = 'haberdash-ui-theme';
  var API_BASE = 'https://zf8klzvd4k.execute-api.us-east-2.amazonaws.com/prod';

  async function loadTheme() {
    try {
      var nodeRes = await fetch(API_BASE + '/api/node?node_id=' + THEME_NODE_ID);
      var nodeData = await nodeRes.json();

      if (nodeData.unstyled || !nodeData.vrgb) {
        console.log('Spectra node is unstyled -- no theme to apply');
        return;
      }

      var params = new URLSearchParams({
        d1_hsl: nodeData.vrgb.d1_hsl.join(','),
        d2_lab: nodeData.vrgb.d2_lab.join(','),
        d3_lab: nodeData.vrgb.d3_lab.join(','),
        d4_lab: nodeData.vrgb.d4_lab.join(',')
      });

      var genRes = await fetch(API_BASE + '/api/generate?' + params.toString());
      var genData = await genRes.json();
      if (!genData.tokens) return;

      var cssRules = genData.tokens.__css_rules__ || '';
      var tokenCSS = Object.entries(genData.tokens)
        .filter(function (entry) { return entry[0] !== '__css_rules__'; })
        .map(function (entry) { return entry[0] + ': ' + entry[1] + ';'; })
        .join(' ');
      var finalCSS = ':root { ' + tokenCSS + ' }\n\n' + cssRules;

      // Stash for theme-toggle restore (surfaces read window._spectraCSS).
      window._spectraCSS = finalCSS;

      if (localStorage.getItem('cue-vox-theme') !== 'off') {
        var el = document.getElementById('vrgb-tokens');
        if (el) {
          // Preserve a surface that toggles the layer via .disabled (pipeline's
          // onstage/backstage). Replacing textContent rebuilds the stylesheet
          // and would otherwise re-enable a disabled one.
          var wasDisabled = el.disabled;
          el.textContent = finalCSS;
          el.disabled = wasDisabled;
        }
      }
      console.log('✓ Loaded Spectra theme');
    } catch (error) {
      console.log('Spectra theme fetch failed:', error);
    }
  }

  loadTheme();
})();
