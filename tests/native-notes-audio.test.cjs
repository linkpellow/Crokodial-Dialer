const assert = require('node:assert/strict');
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const files=fs.readdirSync('artifacts/native-notes').filter(name=>/^segment-\d+\.webm$/.test(name));
assert.ok(files.length>=2);
for(const name of files){
  const file='artifacts/native-notes/'+name;
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',file],{encoding:'utf8'}));
  assert.equal(probe.streams[0].codec_name,'opus');
  const bytes=execFileSync('ffmpeg',['-v','error','-i',file,'-f','f32le','-ar','8000','-ac','1','pipe:1']);
  const audio=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4);
  assert.ok(audio.length>800,'Every standalone segment decodes to meaningful audio');
  function magnitude(frequency){let real=0,imaginary=0;for(let i=0;i<audio.length;i++){const angle=2*Math.PI*frequency*i/8000;real+=audio[i]*Math.cos(angle);imaginary+=audio[i]*Math.sin(angle);}return Math.hypot(real,imaginary)/audio.length;}
  const local=magnitude(440),remote=magnitude(660),noise=magnitude(1000);
  assert.ok(local>0.1 && remote>0.1 && local>noise*10 && remote>noise*10,`${name} must contain both call sides: ${local},${remote},${noise}`);
  console.log('PASS standalone Opus decode and both call-side tones:',name,{samples:audio.length,local:Number(local.toFixed(3)),remote:Number(remote.toFixed(3))});
}

const muted=execFileSync('ffmpeg',['-v','error','-i','artifacts/native-notes/muted-segment.webm','-f','f32le','-ar','8000','-ac','1','pipe:1']);
const signal=new Float32Array(muted.buffer,muted.byteOffset,muted.byteLength/4);
function level(f){let re=0,im=0;for(let i=0;i<signal.length;i++){const phase=2*Math.PI*f*i/8000;re+=signal[i]*Math.cos(phase);im+=signal[i]*Math.sin(phase);}return Math.hypot(re,im)/signal.length;}
assert.ok(level(440)<0.01 && level(660)>0.1,'Muted local audio must not enter recorded notes; remote audio remains');
console.log('PASS muted local side excluded while remote side remains recorded.');
