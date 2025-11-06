import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Phone, PhoneOff, Mic, MicOff } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import Vapi from '@vapi-ai/web';
import { jsPDF } from 'jspdf';
import 'jspdf-autotable';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

const CallInterface = () => {
  const [isCallActive, setIsCallActive] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [callDuration, setCallDuration] = useState(0);
  const callDurationRef = useRef(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const { toast } = useToast();
  
  const vapiRef = useRef<any>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const transcriptRef = useRef<string>('');

  useEffect(() => {
    // Initialize Vapi with public key
    vapiRef.current = new Vapi('701fb7fc-3fe9-4f12-b01a-7afc4ba77af8');

    // Set up event listeners
    vapiRef.current.on('call-start', () => {
      console.log('Call started');
      setIsCallActive(true);
      setMessages([]);
      setCallDuration(0);
      callDurationRef.current = 0;
      transcriptRef.current = '';
      
      // Start call timer
      timerRef.current = setInterval(() => {
        callDurationRef.current += 1;
        setCallDuration(callDurationRef.current);
      }, 1000);

      toast({
        title: "Call Started",
        description: "You're now connected with the virtual nurse assistant.",
      });
    });

    vapiRef.current.on('call-end', async () => {
      console.log('Call ended');
      setIsCallActive(false);
      setIsSpeaking(false);
      
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }

      // Use accumulated final transcript text
      const conversationText = transcriptRef.current;
      
      // Save to MongoDB via local API
      try {
        const res = await fetch('/api/transcripts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            summary: extractSummary(conversationText),
            patientInfo: extractPatientInfo(conversationText),
            transcript: conversationText,
            callDuration: callDurationRef.current,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `Request failed with ${res.status}`);
        }

        toast({
          title: "Call Ended",
          description: "Transcript saved successfully to database.",
        });
      } catch (error) {
        console.error('Error saving transcript:', error);
        toast({
          title: "Error",
          description: "Failed to save transcript. Please try again.",
          variant: "destructive",
        });
      }
    });

    vapiRef.current.on('speech-start', () => {
      console.log('Assistant started speaking');
      setIsSpeaking(true);
    });

    vapiRef.current.on('speech-end', () => {
      console.log('Assistant stopped speaking');
      setIsSpeaking(false);
    });

    vapiRef.current.on('message', (message: any) => {
      console.log('Message received:', message);
      
      if (message.type === 'transcript') {
        const newMessage: Message = {
          role: message.role === 'user' ? 'user' : 'assistant',
          content: message.transcriptType === 'final' ? message.transcript : message.transcript,
          timestamp: new Date(),
        };

        if (message.transcriptType === 'final') {
          setMessages(prev => [...prev, newMessage]);
          transcriptRef.current += `${newMessage.role}: ${newMessage.content}\n`;
        }
      }
    });

    vapiRef.current.on('error', (error: any) => {
      console.error('Vapi error:', error);
      toast({
        title: "Error",
        description: error.message || "An error occurred during the call.",
        variant: "destructive",
      });
    });

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      vapiRef.current?.stop();
    };
  }, [toast]);

  const startCall = async () => {
    try {
      // Prompt for microphone permission explicitly
      if (navigator?.mediaDevices?.getUserMedia) {
        await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      // Start call with assistant ID
      await vapiRef.current.start('72925519-cbb2-424d-9545-f90a2560b364');
    } catch (error) {
      console.error('Error starting call:', error);
      toast({
        title: "Error",
        description: "Failed to start call. Please allow microphone access and check your connection.",
        variant: "destructive",
      });
    }
  };

  const endCall = () => {
    vapiRef.current?.stop();
  };

  const toggleMute = () => {
    const newMuteState = !isMuted;
    setIsMuted(newMuteState);
    vapiRef.current?.setMuted(newMuteState);
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const extractSummary = (text: string): string => {
    // Normalize newlines
    const cleaned = (text || '').replace(/\r/g, '');
    // Prefer an explicit "Summary:" block
    const m1 = cleaned.match(/Summary:\s*([\s\S]*?)(?=\n{2,}|$)/i);
    if (m1 && m1[1]) return m1[1].trim();
    // Or a "Patient Intake Summary:" block
    const m2 = cleaned.match(/Patient Intake Summary:\s*([\s\S]*?)(?=\n{2,}|$)/i);
    if (m2 && m2[1]) return m2[1].trim();
    // Fallback: last N lines, stripped of role prefixes
    const lines = cleaned
      .split(/\n/)
      .map(l => l.replace(/^\s*(assistant|user)\s*:\s*/i, '').trim())
      .filter(Boolean);
    return lines.slice(-12).join(' ');
  };

  const extractPatientInfo = (text: string): any => {
    // Normalize into lines and strip role prefixes like "assistant:" or "user:"
    const lines = text
      .split(/\r?\n/)
      .map(l => l.replace(/^\s*(assistant|user)\s*:\s*/i, '').trim())
      .filter(l => l.length > 0);

    const info: { name?: string; age?: string; gender?: string; symptoms?: string } = {};
    let pending: 'name' | 'age' | 'gender' | 'symptoms' | null = null;

    const setField = (key: 'name' | 'age' | 'gender' | 'symptoms', raw: string) => {
      let val = (raw || '').trim();
      // Remove trailing punctuation
      val = val.replace(/[.,;]+$/g, '').trim();
      // Normalize common filler phrases
      if (/not\s+shared|unknown|n\/a/i.test(val)) val = '';
      if (key === 'age') {
        const num = val.match(/\d{1,3}/)?.[0];
        if (num) val = num;
      }
      (info as any)[key] = val;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match either inline: "Name: James" or label-only: "Name," / "Name:"
      const m = line.match(/^(name|age|gender|symptoms)\s*[:,-]?\s*(.*)$/i);
      if (m) {
        const key = m[1].toLowerCase() as 'name' | 'age' | 'gender' | 'symptoms';
        const rest = (m[2] || '').trim();
        if (rest) {
          setField(key, rest);
          pending = null;
        } else {
          pending = key;
        }
        continue;
      }

      if (pending) {
        setField(pending, line);
        pending = null;
        continue;
      }
    }

    return {
      name: info.name || '',
      age: info.age || '',
      gender: info.gender || '',
      symptoms: info.symptoms || '',
    };
  };

  const downloadSummaryPdf = async () => {
    const text = transcriptRef.current || messages.map(m => `${m.role}: ${m.content}`).join('\n');
    if (!text || text.trim().length === 0) {
      toast({ title: 'No Transcript', description: 'There is no transcript to export yet.' });
      return;
    }
    const summary = extractSummary(text);
    const info = extractPatientInfo(text);

    const doc = new jsPDF();

    let cursorY = 15;

    try {
      const toDataUrl = async (url: string) => {
        const res = await fetch(url, { cache: 'no-store' });
        const blob = await res.blob();
        return await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(blob);
        });
      };
      const logoDataUrl = await toDataUrl('/image.png');
      // Load into Image to get natural dimensions
      const img = new Image();
      const imgLoaded = await new Promise<HTMLImageElement>((resolve) => {
        img.onload = () => resolve(img);
        img.src = logoDataUrl;
      });
      const pageWidth = doc.internal.pageSize.getWidth();
      const maxW = 50; // mm
      const maxH = 20; // mm
      const ratio = Math.min(maxW / imgLoaded.width, maxH / imgLoaded.height);
      const w = Math.max(20, imgLoaded.width * ratio);
      const h = imgLoaded.height * ratio;
      const x = (pageWidth - w) / 2;
      doc.addImage(logoDataUrl, 'PNG', x, cursorY, w, h);
      cursorY += h + 8;
    } catch {}

    doc.setFontSize(16);
    doc.text('Patient Intake Summary', 14, cursorY);
    cursorY += 10;

    const tableBody = [
      ['Name', info.name || ''],
      ['Age', info.age || ''],
      ['Gender', info.gender || ''],
      ['Symptoms', info.symptoms || ''],
    ];

    (doc as any).autoTable({
      head: [['Field', 'Value']],
      body: tableBody,
      startY: cursorY,
      styles: { fontSize: 11 },
      headStyles: { fillColor: [240, 240, 240] },
      columnStyles: {
        0: { cellWidth: 40 },
        1: { cellWidth: 'auto' },
      },
      margin: { left: 14, right: 14 },
    });

    // After table, add summary paragraph
    // @ts-ignore - autoTable provides lastAutoTable
    const afterTableY = (doc as any).lastAutoTable ? (doc as any).lastAutoTable.finalY + 10 : cursorY + 40;
    doc.setFontSize(12);
    doc.text('Summary:', 14, afterTableY);
    const wrapped = doc.splitTextToSize((summary && summary.toLowerCase() !== 'null' ? summary : 'No summary provided.'), 180);
    let y = afterTableY + 7;
    wrapped.forEach((line: string) => {
      if (y > doc.internal.pageSize.getHeight() - 20) {
        doc.addPage();
        y = 20;
      }
      doc.text(line, 14, y);
      y += 7;
    });

    doc.save('patient-summary.pdf');
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-medical-light via-background to-medical-accent p-6">
      <div className="max-w-6xl mx-auto">
        <header className="text-center mb-8 animate-in fade-in slide-in-from-top duration-700">
          <img
            src="/image.png"
            alt="Company Logo"
            className="mx-auto mb-4 h-12 w-auto"
          />
          <h1 className="text-5xl font-bold mb-3 bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
            Nurse Triage AI Assistant
          </h1>
          <p className="text-lg text-muted-foreground">
            Virtual health assessment and patient intake system
          </p>
        </header>

        <div className="grid md:grid-cols-2 gap-6 mb-6">
          {/* Call Controls Card */}
          <Card className="p-8 shadow-lg border-2 transition-all duration-300 hover:shadow-xl">
            <div className="flex flex-col items-center space-y-6">
              <div className="relative">
                <div className={`absolute inset-0 bg-gradient-to-r from-primary to-accent rounded-full blur-xl opacity-30 ${isSpeaking ? 'animate-pulse' : ''}`}></div>
                <div className={`relative w-32 h-32 rounded-full bg-gradient-to-br from-primary to-accent flex items-center justify-center transition-transform duration-300 ${isCallActive ? 'scale-110' : ''} ${isSpeaking ? 'animate-pulse' : ''}`}>
                  {isCallActive ? (
                    <Phone className="w-16 h-16 text-white" />
                  ) : (
                    <PhoneOff className="w-16 h-16 text-white opacity-50" />
                  )}
                </div>
              </div>

              <div className="text-center">
                <p className="text-sm font-medium text-muted-foreground mb-1">Call Status</p>
                <p className={`text-2xl font-bold ${isCallActive ? 'text-primary' : 'text-muted-foreground'}`}>
                  {isCallActive ? 'Active' : 'Inactive'}
                </p>
                {isCallActive && (
                  <p className="text-lg font-mono text-accent mt-2">
                    {formatDuration(callDuration)}
                  </p>
                )}
              </div>

              <div className="flex gap-4 w-full">
                {!isCallActive ? (
                  <Button
                    onClick={startCall}
                    className="flex-1 h-14 text-lg font-semibold bg-gradient-to-r from-primary to-accent hover:opacity-90 transition-all duration-300 hover:scale-105"
                  >
                    <Phone className="mr-2 h-5 w-5" />
                    Start Call
                  </Button>
                ) : (
                  <>
                    <Button
                      onClick={toggleMute}
                      variant="outline"
                      className="flex-1 h-14 border-2"
                    >
                      {isMuted ? (
                        <MicOff className="mr-2 h-5 w-5" />
                      ) : (
                        <Mic className="mr-2 h-5 w-5" />
                      )}
                      {isMuted ? 'Unmute' : 'Mute'}
                    </Button>
                    <Button
                      onClick={endCall}
                      variant="destructive"
                      className="flex-1 h-14"
                    >
                      <PhoneOff className="mr-2 h-5 w-5" />
                      End Call
                    </Button>
                  </>
                )}
              </div>
              <div className="w-full">
                <Button onClick={downloadSummaryPdf} variant="secondary" className="w-full h-12">
                  Download Summary (PDF)
                </Button>
              </div>

              {isSpeaking && (
                <div className="flex items-center gap-2 text-accent animate-in fade-in">
                  <div className="flex gap-1">
                    <div className="w-1 h-4 bg-accent rounded-full animate-pulse" style={{ animationDelay: '0ms' }}></div>
                    <div className="w-1 h-6 bg-accent rounded-full animate-pulse" style={{ animationDelay: '150ms' }}></div>
                    <div className="w-1 h-4 bg-accent rounded-full animate-pulse" style={{ animationDelay: '300ms' }}></div>
                  </div>
                  <span className="text-sm font-medium">Assistant is speaking...</span>
                </div>
              )}
            </div>
          </Card>

          {/* Live Transcription Card */}
          <Card className="p-8 shadow-lg border-2 flex flex-col">
            <h2 className="text-2xl font-bold mb-4 text-primary">Live Transcription</h2>
            <div className="flex-1 overflow-y-auto space-y-3 min-h-[300px] max-h-[400px] pr-2">
              {messages.length === 0 ? (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  <p>Transcription will appear here during the call...</p>
                </div>
              ) : (
                messages.map((message, index) => (
                  <div
                    key={index}
                    className={`p-4 rounded-lg transition-all duration-300 animate-in slide-in-from-bottom ${
                      message.role === 'user'
                        ? 'bg-secondary text-secondary-foreground ml-8'
                        : 'bg-primary/10 text-foreground mr-8'
                    }`}
                  >
                    <p className="text-xs font-semibold mb-1 opacity-70">
                      {message.role === 'user' ? 'Patient' : 'AI Nurse'}
                    </p>
                    <p className="text-sm leading-relaxed">{message.content}</p>
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>

        {/* Instructions Card */}
        <Card className="p-6 bg-gradient-to-br from-card to-medical-light border-2 shadow-md">
          <h3 className="text-lg font-semibold mb-3 text-primary">How It Works</h3>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex items-start gap-2">
              <span className="text-accent font-bold">1.</span>
              <span>Click <strong>"Start Call"</strong> to begin your triage session with the AI nurse</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-accent font-bold">2.</span>
              <span>Answer the nurse's questions about your symptoms and medical history</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-accent font-bold">3.</span>
              <span>Watch the live transcription appear in real-time</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-accent font-bold">4.</span>
              <span>After the call ends, your information will be automatically saved to the database</span>
            </li>
          </ul>
        </Card>
      </div>
    </div>
  );
};

export default CallInterface;