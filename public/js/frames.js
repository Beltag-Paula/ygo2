/* frames.js — circular avatars inside Master Duel icon frames (views/images/frames).
   FRAME_GEO[file] = the centre/radius (in the 512px frame image) of the hole the picture shows through. */
window.FRAME_GEO = {
 "Blue-Eyes_White_Dragon-Icon_Frame-Master_Duel.png": {
  "cx": 249,
  "cy": 269,
  "r": 154,
  "name": "Blue-Eyes White Dragon"
 },
 "Brain_Control-Icon_Frame-Master_Duel.png": {
  "cx": 256,
  "cy": 264,
  "r": 153,
  "name": "Brain Control"
 },
 "Called_by_the_Grave-Icon_Frame-Master_Duel.png": {
  "cx": 256,
  "cy": 256,
  "r": 148,
  "name": "Called by the Grave"
 },
 "Celebration_of_Spring_Breeze-Icon_Frame-Master_Duel.png": {
  "cx": 257,
  "cy": 252,
  "r": 157,
  "name": "Celebration of Spring Breeze"
 },
 "Dark_Magical_Circle-Icon_Frame-Master_Duel.png": {
  "cx": 256,
  "cy": 256,
  "r": 171,
  "name": "Dark Magical Circle"
 },
 "Evil_Eye_of_Selene-Icon_Frame-Master_Duel.png": {
  "cx": 278,
  "cy": 258,
  "r": 168,
  "name": "Evil Eye of Selene"
 },
 "Festive_Ornament-Icon_Frame-Master_Duel.png": {
  "cx": 249,
  "cy": 240,
  "r": 166,
  "name": "Festive Ornament"
 },
 "Flock_Together-Icon_Frame-Master_Duel.png": {
  "cx": 259,
  "cy": 251,
  "r": 140,
  "name": "Flock Together"
 },
 "Flurry_of_Cherry_Blossoms-Icon_Frame-Master_Duel.png": {
  "cx": 256,
  "cy": 256,
  "r": 148,
  "name": "Flurry of Cherry Blossoms"
 },
 "Frost_Frame-Icon_Frame-Master_Duel.png": {
  "cx": 254,
  "cy": 251,
  "r": 147,
  "name": "Frost Frame"
 },
 "Link_Master_Frame-Icon_Frame-Master_Duel.png": {
  "cx": 255,
  "cy": 255,
  "r": 150,
  "name": "Link Master Frame"
 },
 "Magic_Cylinder-Icon_Frame-Master_Duel.png": {
  "cx": 260,
  "cy": 253,
  "r": 150,
  "name": "Magic Cylinder"
 },
 "Maple_Maiden-Icon_Frame-Master_Duel.png": {
  "cx": 274,
  "cy": 270,
  "r": 156,
  "name": "Maple Maiden"
 },
 "Neon_Sign-Icon_Frame-Master_Duel.png": {
  "cx": 259,
  "cy": 257,
  "r": 170,
  "name": "Neon Sign"
 },
 "Night_festival_in_Costume-Icon_Frame-Master_Duel.png": {
  "cx": 263,
  "cy": 275,
  "r": 142,
  "name": "Night festival in Costume"
 },
 "Sky_Striker_Ace_#U2013_Raye-Icon_Frame-Master_Duel.png": {
  "cx": 257,
  "cy": 254,
  "r": 146,
  "name": "Sky Striker Ace – Raye"
 },
 "Tropical_Seaside-Icon_Frame-Master_Duel.png": {
  "cx": 262,
  "cy": 257,
  "r": 166,
  "name": "Tropical Seaside"
 },
 "WCS_2024_Party_Favor-Icon_Frame-Master_Duel.png": {
  "cx": 256,
  "cy": 256,
  "r": 167,
  "name": "WCS 2024 Party Favor"
 }
};
window.DEFAULT_FRAME = "Link_Master_Frame-Icon_Frame-Master_Duel.png";
/** HTML for a round picture centred in a frame. src may be empty (shows the initial). */
window.avatarHTML = function (src, frame, name) {
  var g = FRAME_GEO[frame] || FRAME_GEO[DEFAULT_FRAME], p = function (v) { return (v / 512 * 100).toFixed(2) + '%'; };
  var pos = 'left:' + p(g.cx - g.r) + ';top:' + p(g.cy - g.r) + ';width:' + p(g.r * 2) + ';height:' + p(g.r * 2);
  var pic = src ? '<img class="av-pic" style="' + pos + '" src="' + src + '" alt="">'
                : '<div class="av-pic av-init" style="' + pos + '">' + String(name || '?').charAt(0).toUpperCase() + '</div>';
  return '<div class="av-ring">' + pic + '<img class="av-frame" src="/images/frames/' + encodeURIComponent(frame in FRAME_GEO ? frame : DEFAULT_FRAME) + '" alt=""></div>';
};
