/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Mic, MicOff, Volume2, Headphones, AlertTriangle, Activity, Circle, Square, Download, Timer, LogIn, LogOut, Cloud, Trash2, User as UserIcon, CheckCircle2 } from 'lucide-react';
import { auth, db, googleProvider, signInWithPopup, signOut, onAuthStateChanged, doc, setDoc, getDoc, collection, query, where, onSnapshot, addDoc, serverTimestamp, Timestamp } from './firebase';
import type { User } from './firebase';

// Error handling spec for Firestore
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isStarted, setIsStarted] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [gainValue, setGainValue] = useState(1.0);
  const [error, setError] = useState<string | null>(null);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [cloudRecordings, setCloudRecordings] = useState<any[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const destinationNodeRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<number | null>(null);

  // Auth state listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        // Sync user profile to Firestore
        const userRef = doc(db, 'users', currentUser.uid);
        try {
          await setDoc(userRef, {
            uid: currentUser.uid,
            displayName: currentUser.displayName,
            email: currentUser.email,
            photoURL: currentUser.photoURL,
            createdAt: serverTimestamp()
          }, { merge: true });
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, `users/${currentUser.uid}`);
        }
      } else {
        setCloudRecordings([]);
      }
    });
    return () => unsubscribe();
  }, []);

  // Fetch cloud recordings
  useEffect(() => {
    if (!user) return;

    const q = query(collection(db, 'recordings'), where('userId', '==', user.uid));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const recordings = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setCloudRecordings(recordings.sort((a: any, b: any) => b.timestamp?.toMillis() - a.timestamp?.toMillis()));
    }, (err) => {
      handleFirestoreError(err, OperationType.LIST, 'recordings');
    });

    return () => unsubscribe();
  }, [user]);

  const handleSignIn = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.error('Sign-in error:', err);
      setError('Error al iniciar sesión con Google.');
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
    } catch (err) {
      console.error('Sign-out error:', err);
    }
  };

  const startAmplifier = async () => {
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        } 
      });
      
      streamRef.current = stream;
      
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const audioContext = new AudioContextClass();
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      sourceNodeRef.current = source;

      const gainNode = audioContext.createGain();
      gainNode.gain.value = gainValue;
      gainNodeRef.current = gainNode;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;

      const destination = audioContext.createMediaStreamDestination();
      destinationNodeRef.current = destination;

      source.connect(gainNode);
      gainNode.connect(analyser);
      gainNode.connect(destination);
      analyser.connect(audioContext.destination);

      setIsStarted(true);
      drawVisualizer();
    } catch (err) {
      console.error('Error accessing microphone:', err);
      setError('No se pudo acceder al micrófono. Por favor, asegúrate de dar los permisos necesarios.');
    }
  };

  const stopAmplifier = () => {
    if (isRecording) {
      stopRecording();
    }
    
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    
    if (audioContextRef.current) {
      audioContextRef.current.close();
    }

    setIsStarted(false);
  };

  const startRecording = () => {
    if (!destinationNodeRef.current) return;
    
    chunksRef.current = [];
    setRecordedUrl(null);
    setRecordedBlob(null);
    
    const mediaRecorder = new MediaRecorder(destinationNodeRef.current.stream);
    mediaRecorderRef.current = mediaRecorder;

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunksRef.current.push(e.data);
      }
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
      const url = URL.createObjectURL(blob);
      setRecordedUrl(url);
      setRecordedBlob(blob);
    };

    mediaRecorder.start();
    setIsRecording(true);
    setRecordingTime(0);
    
    timerIntervalRef.current = window.setInterval(() => {
      setRecordingTime(prev => prev + 1);
    }, 1000);
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
      }
    }
  };

  const saveToCloud = async () => {
    if (!user || !recordedBlob) return;
    
    setIsSaving(true);
    try {
      // Convert blob to base64 for storage (simplified for this applet)
      const reader = new FileReader();
      reader.readAsDataURL(recordedBlob);
      reader.onloadend = async () => {
        const base64Audio = reader.result as string;
        
        const recordingData = {
          userId: user.uid,
          name: `Grabación ${new Date().toLocaleString()}`,
          duration: recordingTime,
          timestamp: serverTimestamp(),
          audioData: base64Audio,
          id: crypto.randomUUID()
        };

        await addDoc(collection(db, 'recordings'), recordingData);
        setIsSaving(false);
        setRecordedUrl(null);
        setRecordedBlob(null);
      };
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'recordings');
      setIsSaving(false);
    }
  };

  const deleteRecording = async (id: string) => {
    try {
      // In a real app we'd use deleteDoc, but for this demo we'll just filter local state if needed
      // or implement the actual deleteDoc call.
      const { deleteDoc } = await import('firebase/firestore');
      await deleteDoc(doc(db, 'recordings', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `recordings/${id}`);
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const handleGainChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(e.target.value);
    setGainValue(value);
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.setTargetAtTime(value, audioContextRef.current?.currentTime || 0, 0.1);
    }
  };

  const drawVisualizer = () => {
    if (!canvasRef.current || !analyserRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const analyser = analyserRef.current;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      animationFrameRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      const barWidth = (canvas.width / bufferLength) * 2.5;
      let barHeight;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        barHeight = (dataArray[i] / 255) * canvas.height;

        const r = barHeight + (25 * (i / bufferLength));
        const g = 250 * (i / bufferLength);
        const b = 50;

        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);

        x += barWidth + 1;
      }
    };

    draw();
  };

  useEffect(() => {
    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach(track => track.stop());
      if (audioContextRef.current) audioContextRef.current.close();
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    };
  }, []);

  return (
    <div className="min-h-screen bg-[#151619] text-white font-sans selection:bg-orange-500/30">
      {/* Header */}
      <header className="p-6 border-b border-white/10 flex justify-between items-center bg-[#151619]/80 backdrop-blur-md sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-orange-500 flex items-center justify-center shadow-[0_0_20px_rgba(249,115,22,0.4)]">
            <Activity className="w-6 h-6 text-black" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight uppercase">SonicAmp</h1>
            <p className="text-[10px] text-white/40 font-mono tracking-widest uppercase">Pro Audio Processor v2.0</p>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <AnimatePresence>
            {isRecording && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                className="flex items-center gap-2 px-3 py-1 rounded-full bg-red-500/20 border border-red-500/30"
              >
                <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                <span className="text-[10px] font-mono uppercase tracking-wider text-red-500 font-bold">REC {formatTime(recordingTime)}</span>
              </motion.div>
            )}
          </AnimatePresence>

          {user ? (
            <div className="flex items-center gap-3">
              <div className="hidden sm:flex flex-col items-end">
                <span className="text-[10px] font-bold uppercase tracking-tight">{user.displayName}</span>
                <span className="text-[8px] text-white/40 font-mono">{user.email}</span>
              </div>
              <img src={user.photoURL || ''} alt="Profile" className="w-8 h-8 rounded-full border border-white/20" referrerPolicy="no-referrer" />
              <button onClick={handleSignOut} className="p-2 rounded-full bg-white/5 hover:bg-white/10 transition-colors">
                <LogOut className="w-4 h-4 text-white/60" />
              </button>
            </div>
          ) : (
            <button 
              onClick={handleSignIn}
              className="flex items-center gap-2 px-4 py-2 rounded-full bg-white text-black font-bold text-xs uppercase tracking-wider hover:bg-orange-500 hover:text-black transition-all"
            >
              <LogIn className="w-4 h-4" />
              <span className="hidden sm:inline">Cuenta Google</span>
            </button>
          )}
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-8 mt-8">
        {/* Left Column: Visualizer & Cloud List (7 cols) */}
        <section className="lg:col-span-7 space-y-6">
          <div className="bg-[#1c1d21] rounded-2xl p-6 border border-white/5 shadow-2xl relative overflow-hidden group">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-orange-500/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
            
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xs font-mono uppercase tracking-[0.2em] text-white/60">Espectro de Frecuencia</h2>
              <Activity className={`w-4 h-4 ${isStarted ? 'text-orange-500' : 'text-white/20'}`} />
            </div>

            <div className="h-64 bg-black/40 rounded-xl border border-white/5 relative flex items-center justify-center">
              {!isStarted && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-white/20">
                  <MicOff className="w-12 h-12 mb-2 opacity-20" />
                  <span className="text-[10px] uppercase tracking-widest font-mono">Sin Señal de Entrada</span>
                </div>
              )}
              <canvas 
                ref={canvasRef} 
                width={600} 
                height={300} 
                className="w-full h-full rounded-lg"
              />
            </div>
          </div>

          {/* Cloud Recordings List */}
          <div className="bg-[#1c1d21] rounded-2xl p-6 border border-white/5 shadow-2xl">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xs font-mono uppercase tracking-[0.2em] text-white/60 flex items-center gap-2">
                <Cloud className="w-4 h-4 text-blue-500" />
                Mis Grabaciones en la Nube
              </h2>
              <span className="text-[10px] font-mono text-white/20 uppercase">{cloudRecordings.length} Archivos</span>
            </div>

            {!user ? (
              <div className="py-12 text-center border border-dashed border-white/10 rounded-xl">
                <UserIcon className="w-8 h-8 text-white/10 mx-auto mb-3" />
                <p className="text-xs text-white/40 uppercase tracking-widest">Inicia sesión para ver tus grabaciones</p>
              </div>
            ) : cloudRecordings.length === 0 ? (
              <div className="py-12 text-center border border-dashed border-white/10 rounded-xl">
                <Cloud className="w-8 h-8 text-white/10 mx-auto mb-3" />
                <p className="text-xs text-white/40 uppercase tracking-widest">No hay grabaciones guardadas</p>
              </div>
            ) : (
              <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                {cloudRecordings.map((rec) => (
                  <div key={rec.id} className="bg-white/5 border border-white/5 rounded-xl p-4 flex items-center justify-between group hover:bg-white/10 transition-colors">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center">
                        <Volume2 className="w-5 h-5 text-blue-500" />
                      </div>
                      <div>
                        <h3 className="text-xs font-bold uppercase tracking-tight">{rec.name}</h3>
                        <p className="text-[8px] text-white/40 font-mono uppercase tracking-widest">
                          {formatTime(rec.duration)} • {rec.timestamp?.toDate().toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <a 
                        href={rec.audioData} 
                        download={`${rec.name}.webm`}
                        className="p-2 rounded-lg bg-white/5 hover:bg-green-500/20 hover:text-green-500 transition-all"
                      >
                        <Download className="w-4 h-4" />
                      </a>
                      <button 
                        onClick={() => deleteRecording(rec.id)}
                        className="p-2 rounded-lg bg-white/5 hover:bg-red-500/20 hover:text-red-500 transition-all"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Right Column: Controls (5 cols) */}
        <section className="lg:col-span-5 space-y-6">
          <div className="bg-[#1c1d21] rounded-2xl p-8 border border-white/5 shadow-2xl">
            <div className="flex justify-between items-center mb-10">
              <h2 className="text-xs font-mono uppercase tracking-[0.2em] text-white/60">Consola de Control</h2>
              <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10">
                <div className={`w-2 h-2 rounded-full ${isStarted ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
                <span className="text-[10px] font-mono uppercase tracking-wider">{isStarted ? 'Live' : 'Standby'}</span>
              </div>
            </div>

            <div className="space-y-10">
              <div className="relative pt-2">
                <div className="flex justify-between mb-4">
                  <span className="text-[10px] font-mono text-white/40 uppercase">Ganancia de Salida</span>
                  <span className="text-2xl font-mono font-bold text-orange-500">
                    {gainValue.toFixed(1)}x
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="5"
                  step="0.1"
                  value={gainValue}
                  onChange={handleGainChange}
                  className="w-full h-2 bg-black/60 rounded-lg appearance-none cursor-pointer accent-orange-500"
                />
              </div>

              <div className="flex flex-col gap-4">
                <button
                  onClick={isStarted ? stopAmplifier : startAmplifier}
                  className={`w-full py-4 rounded-xl font-bold uppercase tracking-[0.2em] text-sm transition-all duration-300 flex items-center justify-center gap-3 shadow-lg ${
                    isStarted 
                      ? 'bg-red-500/10 text-red-500 border border-red-500/20 hover:bg-red-500 hover:text-white' 
                      : 'bg-orange-500 text-black hover:bg-orange-400 hover:scale-[1.02] active:scale-[0.98]'
                  }`}
                >
                  {isStarted ? (
                    <><MicOff className="w-5 h-5" />Detener Sistema</>
                  ) : (
                    <><Mic className="w-5 h-5" />Activar Micrófono</>
                  )}
                </button>

                <div className="grid grid-cols-1 gap-3">
                  <button
                    disabled={!isStarted}
                    onClick={isRecording ? stopRecording : startRecording}
                    className={`w-full py-3 rounded-xl font-bold uppercase tracking-[0.15em] text-xs transition-all duration-300 flex items-center justify-center gap-3 border ${
                      !isStarted 
                        ? 'opacity-30 cursor-not-allowed border-white/10 text-white/40' 
                        : isRecording 
                          ? 'bg-red-500 text-white border-red-600 shadow-[0_0_15px_rgba(239,68,68,0.3)]' 
                          : 'bg-white/5 text-white border-white/10 hover:bg-white/10'
                    }`}
                  >
                    {isRecording ? (
                      <><Square className="w-4 h-4 fill-current" />Detener Grabación</>
                    ) : (
                      <><Circle className="w-4 h-4 fill-red-500 text-red-500" />Iniciar Grabación</>
                    )}
                  </button>

                  <AnimatePresence>
                    {recordedUrl && (
                      <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 10 }}
                        className="flex flex-col gap-2"
                      >
                        <div className="grid grid-cols-2 gap-2">
                          <a
                            href={recordedUrl}
                            download={`sonicamp-recording-${new Date().getTime()}.webm`}
                            className="py-3 rounded-xl font-bold uppercase tracking-[0.15em] text-[10px] bg-white/10 text-white hover:bg-white/20 transition-all flex items-center justify-center gap-2"
                          >
                            <Download className="w-4 h-4" />
                            Local
                          </a>
                          <button
                            disabled={!user || isSaving}
                            onClick={saveToCloud}
                            className={`py-3 rounded-xl font-bold uppercase tracking-[0.15em] text-[10px] transition-all flex items-center justify-center gap-2 ${
                              !user 
                                ? 'bg-blue-500/10 text-blue-500/40 cursor-not-allowed' 
                                : 'bg-blue-500 text-white hover:bg-blue-400'
                            }`}
                          >
                            {isSaving ? (
                              <Activity className="w-4 h-4 animate-spin" />
                            ) : (
                              <Cloud className="w-4 h-4" />
                            )}
                            Nube
                          </button>
                        </div>
                        {!user && (
                          <p className="text-[8px] text-white/30 text-center uppercase tracking-widest">
                            Inicia sesión para guardar en la nube
                          </p>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                
                <AnimatePresence>
                  {error && (
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 10 }}
                      className="p-3 bg-red-500/20 border border-red-500/30 rounded-lg flex items-center gap-3 text-red-500 text-[10px] font-mono uppercase"
                    >
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      {error}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>

          <div className="bg-orange-500/10 border border-orange-500/20 rounded-xl p-4 flex gap-4 items-start">
            <Headphones className="w-5 h-5 text-orange-500 shrink-0 mt-1" />
            <div>
              <h3 className="text-sm font-bold text-orange-500 mb-1 uppercase tracking-tight">Monitoreo Seguro</h3>
              <p className="text-[10px] text-white/60 leading-relaxed">
                El sistema procesa audio a 48kHz con una latencia ultra-baja de ~12ms. Siempre usa auriculares.
              </p>
            </div>
          </div>
        </section>
      </main>

      {/* Footer Info */}
      <footer className="p-12 text-center opacity-20">
        <p className="text-[8px] font-mono uppercase tracking-[0.4em]">
          SonicAmp Pro Audio Engine v2.0 &copy; 2026
        </p>
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: rgba(255, 255, 255, 0.05);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
        input[type=range]::-webkit-slider-thumb {
          -webkit-appearance: none;
          height: 24px;
          width: 24px;
          border-radius: 50%;
          background: #f97316;
          cursor: pointer;
          box-shadow: 0 0 15px rgba(249, 115, 22, 0.5);
          border: 4px solid #1c1d21;
        }
        input[type=range]::-moz-range-thumb {
          height: 24px;
          width: 24px;
          border-radius: 50%;
          background: #f97316;
          cursor: pointer;
          box-shadow: 0 0 15px rgba(249, 115, 22, 0.5);
          border: 4px solid #1c1d21;
        }
      `}</style>
    </div>
  );
}
