import { createClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import AuditLogsClient, { type AuditLog, type AuditLogStatus } from './AuditLogsClient';
import { getAuditLogHealth } from '@/lib/audit-log';

// PostgREST reports a missing table as PGRST205; Postgres itself uses 42P01.
const MISSING_TABLE_CODES = new Set(['PGRST205', '42P01']);

export default async function DashboardAuditLogsPage() {
  const supabase = createClient();

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    redirect('/login');
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', session.user.id)
    .single();

  if (profile?.role !== 'salam') {
    redirect('/unauthorized');
  }

  const { data: logs, error } = await supabase
    .from('audit_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(300);

  // A failed read used to be logged and then dropped, so the page rendered an
  // empty list — indistinguishable from "nothing has happened yet". That is
  // exactly how a months-long outage went unnoticed. Pass the failure through.
  if (error) {
    console.error('Error fetching audit logs:', error);
  }

  const writeHealth = getAuditLogHealth();
  const status: AuditLogStatus = {
    readError: error?.message || null,
    tableMissing:
      MISSING_TABLE_CODES.has(error?.code || '') || writeHealth.tableMissing,
    writeFailures: writeHealth.failures,
    lastWriteError: writeHealth.lastError,
  };

  return (
    <div className="p-8 text-black">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="border-b border-gray-200 pb-5">
          <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Audit Logs</h1>
          <p className="text-gray-500 mt-1">Recent dashboard, payment, invoice, brand, and notification events.</p>
        </div>

        <AuditLogsClient initialLogs={(logs || []) as AuditLog[]} status={status} />
      </div>
    </div>
  );
}
