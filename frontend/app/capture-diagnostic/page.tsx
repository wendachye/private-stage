import { notFound } from 'next/navigation';
import CaptureDiagnostic from '../../client/capture-diagnostic';

export default function Page() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return <CaptureDiagnostic />;
}
