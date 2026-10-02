// Domain row types (mirror the SQL schema). Used to type query results until
// `pnpm db:types` generates the full Supabase types from the live DB.

export type VehicleStatus = 'available' | 'on_hire' | 'off_road' | 'sold';
export type DriverStatus = 'lead' | 'vetting' | 'active' | 'suspended' | 'terminated';
export type AgreementType = 'standard' | 'rtb';
export type AgreementStatus = 'draft' | 'pending_signature' | 'active' | 'ended' | 'defaulted' | 'transferred';
export type GfvStatus = 'unconfirmed' | 'confirmed' | 'settled' | 'na';
export type InvoiceStatus = 'open' | 'paid' | 'part_paid' | 'void' | 'overdue';
export type ChargeType = 'pcn' | 'congestion' | 'ulez' | 'dartford' | 'toll' | 'other';
export type ChargeStatus =
  | 'received' | 'driver_notified' | 'driver_liable' | 'disputed' | 'paid_by_driver' | 'paid_by_company' | 'cancelled';
export type ObligationStatus = 'open' | 'due_soon' | 'overdue' | 'resolved' | 'dismissed';
export type Severity = 'info' | 'warning' | 'critical';
export type CertStatus = 'pending' | 'verified' | 'rejected' | 'expired';

export interface Vehicle {
  id: string;
  registration: string;
  make: string;
  model: string;
  colour: string | null;
  model_year: number | null;
  co2_gkm: number | null;
  list_value_pence: number;
  status: VehicleStatus;
  acquired_on: string | null;
  ved_annual_pence: number;
  ved_renewal_on: string | null;
  mot_due_on: string | null;
  residual_estimate_pence: number | null;
  fuel: string;
  service_interval_miles: number | null;
  last_service_miles: number | null;
}

export interface FinanceAgreement {
  id: string;
  vehicle_id: string;
  funder: string | null;
  initial_rental_pence: number;
  monthly_payment_pence: number;
  apr: number;
  term_months: number;
  start_on: string | null;
  amount_financed_pence: number | null;
  gfv_amount_pence: number | null;
  gfv_status: GfvStatus;
  gfv_due_on: string | null;
}

export interface Driver {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  status: DriverStatus;
  pco_licence_no: string | null;
  pco_licence_expiry: string | null;
  dvla_checked_on: string | null;
}

export interface Agreement {
  id: string;
  type: AgreementType;
  vehicle_id: string;
  driver_id: string;
  status: AgreementStatus;
  start_date: string | null;
  end_date: string | null;
  term_weeks: number | null;
  weekly_gross_pence: number;
  weekly_net_pence: number;
  weekly_vat_pence: number;
  deposit_pence: number;
  option_credit_weekly_pence: number | null;
  agreed_residual_pence: number | null;
  excess_mile_pence: number;
  signed_on: string | null;
}

export interface Invoice {
  id: string;
  agreement_id: string;
  number: string | null;
  issued_on: string;
  due_on: string;
  gross_pence: number;
  net_pence: number;
  vat_pence: number;
  status: InvoiceStatus;
  allocated_pence?: number;
  balance_pence?: number;
  is_overdue?: boolean;
}

export interface Charge {
  id: string;
  vehicle_id: string;
  driver_id: string | null;
  type: ChargeType;
  authority: string | null;
  reference: string | null;
  received_on: string;
  report_due_at: string | null;
  amount_pence: number;
  status: ChargeStatus;
}

export interface Obligation {
  id: string;
  entity_type: string;
  entity_id: string;
  type: string;
  title: string;
  due_date: string;
  status: ObligationStatus;
  severity: Severity;
}

export interface InsuranceCertificate {
  id: string;
  driver_id: string;
  insurer: string;
  policy_no: string;
  cover_from: string;
  cover_to: string;
  status: CertStatus;
  doc_path: string | null;
}

export interface RtbEquityRow {
  week_no: number;
  credit_pence: number;
  cumulative_credit_pence: number;
  deposit_pence: number;
  equity_total_pence: number;
  as_of: string;
}

export interface VehicleEconomics {
  vehicle_id: string;
  registration: string;
  status: VehicleStatus;
  agreement_type: AgreementType | null;
  contracted_annual_net_pence: number | null;
  annual_lease_pence: number;
  maintenance_12m_pence: number;
  ved_annual_pence: number;
  contracted_annual_profit_pence: number | null;
  net_received_to_date_pence: number;
  occupancy_12m_pct: number;
  gfv_status: GfvStatus;
  gfv_due_on: string | null;
}
