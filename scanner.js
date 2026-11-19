import QrScanner from '/qr-scanner.min.js';
import {$,badge,icon,h} from './ui.js';

let camera=null;
let video=null;
let previewReady=false;
let cameras=[];
let generation=0;
let last=null;
let lastSeen=0;
let processing=false;
let audio=null;
let blocked=false;

export function status(message,tone='neutral') {
  const node=$('#scan-status');
  if (!node) {
    const dock=$('#camera-dock small');
    if (dock) {dock.textContent=message;dock.className=tone;}
    return;
  }
  node.className='scan-status '+tone;
  node.innerHTML=icon(tone==='success'?'check':tone==='error'?'alert':'camera',19)+h(message);
}
function updateUI() {
  if (!$('#camera-stage')) return;
  $('#camera-stage').classList.toggle('active',previewReady);
  $('#camera-start').hidden=!!camera;
  $('#camera-stop').hidden=!camera;
  if (!previewReady) {
    $('#camera-flash').hidden=true;
    $('#camera-select').disabled=true;
  }
  const label=previewReady?'Ativa':camera?'Iniciando…':'Desligada';
  $('#camera-badge').innerHTML=badge(previewReady?'closed':'neutral',label);
}
export function stop(announce=false) {
  generation++;
  if (camera) {
    camera.pause(true);
    camera.destroy();
    if (video?.parentElement?.id==='camera-stage') {
      const replacement=video.cloneNode(false);
      replacement.removeAttribute('style');
      video.replaceWith(replacement);
    }
  }
  camera=null;
  video=null;
  previewReady=false;
  cameras=[];
  const dock=$('#camera-dock');
  if (dock) dock.hidden=true;
  last=null;
  blocked=false;
  updateUI();
  if (announce) status('Câmera desligada.');
}
export function prepareSound() {
  try {
    const Context=window.AudioContext || window.webkitAudioContext;
    if (!audio && Context) audio=new Context();
    audio?.resume().catch(()=>{});
  } catch {}
}
export function feedback(success,vibrate) {
  if (vibrate && navigator.vibrate) navigator.vibrate(success?85:[45,45,45]);
  try {
    if (!audio || audio.state!=='running') return;
    const oscillator=audio.createOscillator();
    const volume=audio.createGain();
    oscillator.frequency.value=success?740:280;
    volume.gain.setValueAtTime(.11,audio.currentTime);
    volume.gain.exponentialRampToValueAtTime(.005,audio.currentTime+.19);
    oscillator.connect(volume).connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime+.2);
  } catch {}
}
async function flashState() {
  const current=camera;
  const flash=$('#camera-flash');
  if (!current || !flash) return;
  const hasFlash=await current.hasFlash().catch(()=>false);
  if (camera!==current) return;
  flash.hidden=!hasFlash;
  flash.setAttribute('aria-pressed',String(current.isFlashOn()));
}
export async function start(onScan) {
  if (camera) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    status('A câmera exige HTTPS na rede da loja. Use localhost apenas no computador do servidor.','error');
    return;
  }
  prepareSound();
  const token=++generation;
  let failures=0;
  video=$('#camera-video');
  camera=new QrScanner(video,async result=>{
    if (token!==generation) return;
    const time=Date.now();
    failures=0;
    const repeated=result.data===last && time-lastSeen<1400;
    lastSeen=time;
    if (repeated || processing) return;
    last=result.data;
    processing=true;
    try {await onScan(result.data);}
    finally {processing=false;}
  },{
    preferredCamera:'environment',maxScansPerSecond:14,returnDetailedScanResult:true,
    onDecodeError:error=>{
      if (token!==generation) return;
      if (String(error).includes('No QR code found')) {
        failures++;
        if (failures>8 && Date.now()-lastSeen>900) last=null;
      } else if (!blocked) {
        blocked=true;
        status('Falha na leitura da câmera. Desligue e tente novamente.','error');
      }
    }
  });
  updateUI();
  status('Iniciando a câmera…');
  try {
    await camera.start();
    if (token!==generation) return;
    if (video.readyState<video.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) {
      stop();
      status('A câmera foi detectada, mas não enviou imagem. Feche outros apps que usam a câmera e tente novamente.','error');
      return;
    }
    previewReady=true;
    updateUI();
    status('Câmera pronta. Enquadre o QR do cartão.');
    const values=await QrScanner.listCameras(true).catch(()=>[]);
    if (token!==generation) return;
    cameras=values;
    configureSelect();
    await flashState();
  } catch (error) {
    if (token!==generation) return;
    stop();
    status(error.name==='NotAllowedError'?'Permita o acesso à câmera nas configurações do navegador.':
      'Não foi possível ativar a câmera. Verifique a permissão e se ela está em uso.','error');
  }
}
export async function setCamera(id) {
  if (!camera) return;
  try {
    await camera.setCamera(id);
    await flashState();
    status('Câmera selecionada.');
  } catch {
    status('Não foi possível trocar a câmera.','error');
  }
}
export async function flash() {
  if (!camera) return;
  try {
    await camera.toggleFlash();
    await flashState();
  } catch {
    status('Lanterna indisponível nesta câmera.','error');
  }
}

function configureSelect() {
  const select=$('#camera-select');
  if (!select) return;
  const actual=video?.srcObject?.getVideoTracks()[0]?.getSettings().deviceId;
  select.replaceChildren(...cameras.map(item=>new Option(item.label,item.id,false,item.id===actual)));
  select.disabled=!cameras.length;
}
export function mountDock() {
  const dock=$('#camera-dock');
  if (!camera || !video || !dock) return;
  $('.dock-video',dock).append(video);
  dock.hidden=false;
  video.play().catch(()=>{});
}
export function restore() {
  const stage=$('#camera-stage');
  if (!camera || !video || !stage) return;
  const placeholder=$('#camera-video',stage);
  if (placeholder!==video) placeholder.replaceWith(video);
  updateUI();
  if (previewReady) {
    video.play().catch(()=>{});
    configureSelect();
    status('Câmera pronta. Enquadre o QR do cartão.');
    flashState();
  } else {
    status('Iniciando a câmera…');
  }
}
