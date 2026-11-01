/**
 * Phase 14 (Training, Design §4.3, Worker): Recorder-Boundary für den Worker –
 * in APP_ENV=demo zeichnet der Worker bestätigte Staff-Antworten (Mail-Job
 * `mail.send` ⇒ Sent-Listener, WhatsApp-Job `whatsapp.send`) als Trainings-
 * ereignis auf; in allen anderen Umgebungen ist der Recorder ein Noop (§43).
 */
export {
  DemoTrainingEventRecorder,
  createNoopTrainingRecorder,
  createTrainingMailSentListener,
  type TrainingEventRecorder,
} from '../training/index.ts';
