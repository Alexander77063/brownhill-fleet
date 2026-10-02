export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      addons: {
        Row: {
          active: boolean
          created_at: string
          deposit_pence: number
          description: string | null
          feature_key: string
          id: string
          job_kind: string | null
          key: string
          kind: string
          name: string
          pricing_model: string
          region: string | null
          stripe_meter_id: string | null
          stripe_price_id: string | null
          unit_cost_pence: number
          unit_price_pence: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          deposit_pence?: number
          description?: string | null
          feature_key: string
          id?: string
          job_kind?: string | null
          key: string
          kind?: string
          name: string
          pricing_model?: string
          region?: string | null
          stripe_meter_id?: string | null
          stripe_price_id?: string | null
          unit_cost_pence?: number
          unit_price_pence?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          deposit_pence?: number
          description?: string | null
          feature_key?: string
          id?: string
          job_kind?: string | null
          key?: string
          kind?: string
          name?: string
          pricing_model?: string
          region?: string | null
          stripe_meter_id?: string | null
          stripe_price_id?: string | null
          unit_cost_pence?: number
          unit_price_pence?: number
          updated_at?: string
        }
        Relationships: []
      }
      agreements: {
        Row: {
          agreed_residual_pence: number | null
          created_at: string
          deposit_pence: number
          driver_id: string
          end_date: string | null
          excess_mile_pence: number
          id: string
          notice_weeks: number
          option_credit_weekly_pence: number | null
          signed_doc_path: string | null
          signed_on: string | null
          start_date: string | null
          status: Database["public"]["Enums"]["agreement_status"]
          tenant_id: string
          term_weeks: number | null
          type: Database["public"]["Enums"]["agreement_type"]
          updated_at: string
          vehicle_id: string
          weekly_gross_pence: number
          weekly_net_pence: number
          weekly_vat_pence: number
        }
        Insert: {
          agreed_residual_pence?: number | null
          created_at?: string
          deposit_pence?: number
          driver_id: string
          end_date?: string | null
          excess_mile_pence?: number
          id?: string
          notice_weeks?: number
          option_credit_weekly_pence?: number | null
          signed_doc_path?: string | null
          signed_on?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["agreement_status"]
          tenant_id: string
          term_weeks?: number | null
          type: Database["public"]["Enums"]["agreement_type"]
          updated_at?: string
          vehicle_id: string
          weekly_gross_pence: number
          weekly_net_pence: number
          weekly_vat_pence: number
        }
        Update: {
          agreed_residual_pence?: number | null
          created_at?: string
          deposit_pence?: number
          driver_id?: string
          end_date?: string | null
          excess_mile_pence?: number
          id?: string
          notice_weeks?: number
          option_credit_weekly_pence?: number | null
          signed_doc_path?: string | null
          signed_on?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["agreement_status"]
          tenant_id?: string
          term_weeks?: number | null
          type?: Database["public"]["Enums"]["agreement_type"]
          updated_at?: string
          vehicle_id?: string
          weekly_gross_pence?: number
          weekly_net_pence?: number
          weekly_vat_pence?: number
        }
        Relationships: [
          {
            foreignKeyName: "agreements_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agreements_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agreements_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_investor_vehicle"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "agreements_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "agreements_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "agreements_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          actor: string | null
          created_at: string
          detail: Json | null
          entity_id: string | null
          entity_type: string | null
          id: number
          tenant_id: string
        }
        Insert: {
          action: string
          actor?: string | null
          created_at?: string
          detail?: Json | null
          entity_id?: string | null
          entity_type?: string | null
          id?: never
          tenant_id: string
        }
        Update: {
          action?: string
          actor?: string | null
          created_at?: string
          detail?: Json | null
          entity_id?: string | null
          entity_type?: string | null
          id?: never
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_events: {
        Row: {
          id: string
          received_at: string
          tenant_id: string | null
          type: string
        }
        Insert: {
          id: string
          received_at?: string
          tenant_id?: string | null
          type: string
        }
        Update: {
          id?: string
          received_at?: string
          tenant_id?: string | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      bookings: {
        Row: {
          created_at: string
          created_by: string | null
          driver_id: string | null
          dropoff: string
          fare_pence: number | null
          id: string
          notes: string | null
          passenger_name: string | null
          passenger_phone: string | null
          pickup: string
          reference: string
          scheduled_at: string | null
          source: Database["public"]["Enums"]["booking_source"]
          status: Database["public"]["Enums"]["booking_status"]
          tenant_id: string
          updated_at: string
          vehicle_id: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          driver_id?: string | null
          dropoff: string
          fare_pence?: number | null
          id?: string
          notes?: string | null
          passenger_name?: string | null
          passenger_phone?: string | null
          pickup: string
          reference: string
          scheduled_at?: string | null
          source?: Database["public"]["Enums"]["booking_source"]
          status?: Database["public"]["Enums"]["booking_status"]
          tenant_id: string
          updated_at?: string
          vehicle_id?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          driver_id?: string | null
          dropoff?: string
          fare_pence?: number | null
          id?: string
          notes?: string | null
          passenger_name?: string | null
          passenger_phone?: string | null
          pickup?: string
          reference?: string
          scheduled_at?: string | null
          source?: Database["public"]["Enums"]["booking_source"]
          status?: Database["public"]["Enums"]["booking_status"]
          tenant_id?: string
          updated_at?: string
          vehicle_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bookings_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_investor_vehicle"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "bookings_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "bookings_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "bookings_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      charge_liability_transfers: {
        Row: {
          agreement_id: string | null
          charge_id: string
          driver_id: string
          id: string
          method: string
          note: string | null
          reference: string
          signing_session_id: string | null
          tenant_id: string
          transferred_at: string
          transferred_by: string | null
        }
        Insert: {
          agreement_id?: string | null
          charge_id: string
          driver_id: string
          id?: string
          method?: string
          note?: string | null
          reference: string
          signing_session_id?: string | null
          tenant_id: string
          transferred_at?: string
          transferred_by?: string | null
        }
        Update: {
          agreement_id?: string | null
          charge_id?: string
          driver_id?: string
          id?: string
          method?: string
          note?: string | null
          reference?: string
          signing_session_id?: string | null
          tenant_id?: string
          transferred_at?: string
          transferred_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "charge_liability_transfers_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "agreements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "charge_liability_transfers_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_agreement_arrears"
            referencedColumns: ["agreement_id"]
          },
          {
            foreignKeyName: "charge_liability_transfers_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["active_agreement_id"]
          },
          {
            foreignKeyName: "charge_liability_transfers_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["active_agreement_id"]
          },
          {
            foreignKeyName: "charge_liability_transfers_charge_id_fkey"
            columns: ["charge_id"]
            isOneToOne: false
            referencedRelation: "charges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "charge_liability_transfers_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "charge_liability_transfers_signing_session_id_fkey"
            columns: ["signing_session_id"]
            isOneToOne: false
            referencedRelation: "signing_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "charge_liability_transfers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "charge_liability_transfers_transferred_by_fkey"
            columns: ["transferred_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      charge_media: {
        Row: {
          charge_id: string
          created_at: string
          created_by: string | null
          doc_path: string
          id: string
          kind: string
          tenant_id: string
        }
        Insert: {
          charge_id: string
          created_at?: string
          created_by?: string | null
          doc_path: string
          id?: string
          kind?: string
          tenant_id: string
        }
        Update: {
          charge_id?: string
          created_at?: string
          created_by?: string | null
          doc_path?: string
          id?: string
          kind?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "charge_media_charge_id_fkey"
            columns: ["charge_id"]
            isOneToOne: false
            referencedRelation: "charges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "charge_media_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "charge_media_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      charges: {
        Row: {
          agreement_id: string | null
          amount_pence: number
          authority: string | null
          category_id: string | null
          created_at: string
          doc_path: string | null
          driver_id: string | null
          id: string
          incident_on: string | null
          notes: string | null
          received_on: string
          reference: string | null
          report_due_at: string | null
          status: Database["public"]["Enums"]["charge_status"]
          submitted_by_driver: boolean
          tenant_id: string
          type: Database["public"]["Enums"]["charge_type"]
          updated_at: string
          vehicle_id: string
        }
        Insert: {
          agreement_id?: string | null
          amount_pence: number
          authority?: string | null
          category_id?: string | null
          created_at?: string
          doc_path?: string | null
          driver_id?: string | null
          id?: string
          incident_on?: string | null
          notes?: string | null
          received_on?: string
          reference?: string | null
          report_due_at?: string | null
          status?: Database["public"]["Enums"]["charge_status"]
          submitted_by_driver?: boolean
          tenant_id: string
          type: Database["public"]["Enums"]["charge_type"]
          updated_at?: string
          vehicle_id: string
        }
        Update: {
          agreement_id?: string | null
          amount_pence?: number
          authority?: string | null
          category_id?: string | null
          created_at?: string
          doc_path?: string | null
          driver_id?: string | null
          id?: string
          incident_on?: string | null
          notes?: string | null
          received_on?: string
          reference?: string | null
          report_due_at?: string | null
          status?: Database["public"]["Enums"]["charge_status"]
          submitted_by_driver?: boolean
          tenant_id?: string
          type?: Database["public"]["Enums"]["charge_type"]
          updated_at?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "charges_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "agreements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "charges_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_agreement_arrears"
            referencedColumns: ["agreement_id"]
          },
          {
            foreignKeyName: "charges_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["active_agreement_id"]
          },
          {
            foreignKeyName: "charges_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["active_agreement_id"]
          },
          {
            foreignKeyName: "charges_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "expense_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "charges_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "charges_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "charges_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_investor_vehicle"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "charges_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "charges_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "charges_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      deposit_ledger: {
        Row: {
          agreement_id: string
          amount_pence: number
          created_at: string
          event: Database["public"]["Enums"]["deposit_event"]
          id: string
          occurred_on: string
          reason: string | null
          tenant_id: string
        }
        Insert: {
          agreement_id: string
          amount_pence: number
          created_at?: string
          event: Database["public"]["Enums"]["deposit_event"]
          id?: string
          occurred_on?: string
          reason?: string | null
          tenant_id: string
        }
        Update: {
          agreement_id?: string
          amount_pence?: number
          created_at?: string
          event?: Database["public"]["Enums"]["deposit_event"]
          id?: string
          occurred_on?: string
          reason?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "deposit_ledger_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "agreements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deposit_ledger_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_agreement_arrears"
            referencedColumns: ["agreement_id"]
          },
          {
            foreignKeyName: "deposit_ledger_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["active_agreement_id"]
          },
          {
            foreignKeyName: "deposit_ledger_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["active_agreement_id"]
          },
          {
            foreignKeyName: "deposit_ledger_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      device_units: {
        Row: {
          batch_ref: string | null
          created_at: string
          firmware: string | null
          has_immobiliser: boolean
          iccid: string | null
          id: string
          imei: string
          last_seen_at: string | null
          model: string | null
          msisdn: string | null
          notes: string | null
          purchased_on: string | null
          state: string
          tenant_id: string | null
          traccar_device_id: number | null
          traccar_pending: boolean
          unit_cost_minor: number
          updated_at: string
          vehicle_id: string | null
          vendor: string | null
        }
        Insert: {
          batch_ref?: string | null
          created_at?: string
          firmware?: string | null
          has_immobiliser?: boolean
          iccid?: string | null
          id?: string
          imei: string
          last_seen_at?: string | null
          model?: string | null
          msisdn?: string | null
          notes?: string | null
          purchased_on?: string | null
          state?: string
          tenant_id?: string | null
          traccar_device_id?: number | null
          traccar_pending?: boolean
          unit_cost_minor?: number
          updated_at?: string
          vehicle_id?: string | null
          vendor?: string | null
        }
        Update: {
          batch_ref?: string | null
          created_at?: string
          firmware?: string | null
          has_immobiliser?: boolean
          iccid?: string | null
          id?: string
          imei?: string
          last_seen_at?: string | null
          model?: string | null
          msisdn?: string | null
          notes?: string | null
          purchased_on?: string | null
          state?: string
          tenant_id?: string | null
          traccar_device_id?: number | null
          traccar_pending?: boolean
          unit_cost_minor?: number
          updated_at?: string
          vehicle_id?: string | null
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "device_units_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_units_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_investor_vehicle"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "device_units_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "device_units_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "device_units_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_documents: {
        Row: {
          created_at: string
          doc_path: string | null
          driver_id: string
          expires_on: string | null
          id: string
          issued_on: string | null
          kind: string
          reference: string | null
          status: string
          tenant_id: string
          title: string | null
          uploaded_by: string | null
        }
        Insert: {
          created_at?: string
          doc_path?: string | null
          driver_id: string
          expires_on?: string | null
          id?: string
          issued_on?: string | null
          kind: string
          reference?: string | null
          status?: string
          tenant_id: string
          title?: string | null
          uploaded_by?: string | null
        }
        Update: {
          created_at?: string
          doc_path?: string | null
          driver_id?: string
          expires_on?: string | null
          id?: string
          issued_on?: string | null
          kind?: string
          reference?: string | null
          status?: string
          tenant_id?: string
          title?: string | null
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "driver_documents_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_documents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      drivers: {
        Row: {
          address: string | null
          created_at: string
          date_of_birth: string | null
          dvla_check_code: string | null
          dvla_checked_on: string | null
          dvla_licence_no: string | null
          email: string | null
          full_name: string
          id: string
          notes: string | null
          pco_licence_expiry: string | null
          pco_licence_no: string | null
          phone: string | null
          status: Database["public"]["Enums"]["driver_status"]
          tenant_id: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          created_at?: string
          date_of_birth?: string | null
          dvla_check_code?: string | null
          dvla_checked_on?: string | null
          dvla_licence_no?: string | null
          email?: string | null
          full_name: string
          id?: string
          notes?: string | null
          pco_licence_expiry?: string | null
          pco_licence_no?: string | null
          phone?: string | null
          status?: Database["public"]["Enums"]["driver_status"]
          tenant_id: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          created_at?: string
          date_of_birth?: string | null
          dvla_check_code?: string | null
          dvla_checked_on?: string | null
          dvla_licence_no?: string | null
          email?: string | null
          full_name?: string
          id?: string
          notes?: string | null
          pco_licence_expiry?: string | null
          pco_licence_no?: string | null
          phone?: string | null
          status?: Database["public"]["Enums"]["driver_status"]
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "drivers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_categories: {
        Row: {
          created_at: string
          driver_submittable: boolean
          id: string
          is_active: boolean
          kind: string
          name: string
          tenant_id: string
          vat_treatment: string
        }
        Insert: {
          created_at?: string
          driver_submittable?: boolean
          id?: string
          is_active?: boolean
          kind?: string
          name: string
          tenant_id: string
          vat_treatment?: string
        }
        Update: {
          created_at?: string
          driver_submittable?: boolean
          id?: string
          is_active?: boolean
          kind?: string
          name?: string
          tenant_id?: string
          vat_treatment?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_categories_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      expenses: {
        Row: {
          amount_pence: number
          category_id: string | null
          created_at: string
          created_by: string | null
          description: string | null
          doc_path: string | null
          driver_id: string | null
          id: string
          incurred_on: string
          reference: string
          tenant_id: string
          vehicle_id: string | null
        }
        Insert: {
          amount_pence: number
          category_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          doc_path?: string | null
          driver_id?: string | null
          id?: string
          incurred_on?: string
          reference: string
          tenant_id: string
          vehicle_id?: string | null
        }
        Update: {
          amount_pence?: number
          category_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          doc_path?: string | null
          driver_id?: string | null
          id?: string
          incurred_on?: string
          reference?: string
          tenant_id?: string
          vehicle_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "expenses_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "expense_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_investor_vehicle"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "expenses_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "expenses_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "expenses_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      finance_agreements: {
        Row: {
          amount_financed_pence: number | null
          apr: number
          created_at: string
          funder: string | null
          gfv_amount_pence: number | null
          gfv_due_on: string | null
          gfv_status: Database["public"]["Enums"]["gfv_status"]
          id: string
          initial_rental_pence: number
          monthly_payment_pence: number
          reference: string | null
          start_on: string | null
          tenant_id: string
          term_months: number
          updated_at: string
          vehicle_id: string
        }
        Insert: {
          amount_financed_pence?: number | null
          apr: number
          created_at?: string
          funder?: string | null
          gfv_amount_pence?: number | null
          gfv_due_on?: string | null
          gfv_status?: Database["public"]["Enums"]["gfv_status"]
          id?: string
          initial_rental_pence: number
          monthly_payment_pence: number
          reference?: string | null
          start_on?: string | null
          tenant_id: string
          term_months: number
          updated_at?: string
          vehicle_id: string
        }
        Update: {
          amount_financed_pence?: number | null
          apr?: number
          created_at?: string
          funder?: string | null
          gfv_amount_pence?: number | null
          gfv_due_on?: string | null
          gfv_status?: Database["public"]["Enums"]["gfv_status"]
          id?: string
          initial_rental_pence?: number
          monthly_payment_pence?: number
          reference?: string | null
          start_on?: string | null
          tenant_id?: string
          term_months?: number
          updated_at?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "finance_agreements_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_agreements_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_investor_vehicle"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "finance_agreements_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "finance_agreements_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "finance_agreements_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      fuel_logs: {
        Row: {
          cost_minor: number
          created_at: string
          driver_id: string | null
          filled_at: string
          id: string
          litres: number
          logged_by: string | null
          note: string | null
          odometer_km: number | null
          payment_method: Database["public"]["Enums"]["fuel_payment_method"]
          receipt_path: string | null
          station: string | null
          tenant_id: string
          updated_at: string
          vehicle_id: string
        }
        Insert: {
          cost_minor: number
          created_at?: string
          driver_id?: string | null
          filled_at?: string
          id?: string
          litres: number
          logged_by?: string | null
          note?: string | null
          odometer_km?: number | null
          payment_method?: Database["public"]["Enums"]["fuel_payment_method"]
          receipt_path?: string | null
          station?: string | null
          tenant_id: string
          updated_at?: string
          vehicle_id: string
        }
        Update: {
          cost_minor?: number
          created_at?: string
          driver_id?: string | null
          filled_at?: string
          id?: string
          litres?: number
          logged_by?: string | null
          note?: string | null
          odometer_km?: number | null
          payment_method?: Database["public"]["Enums"]["fuel_payment_method"]
          receipt_path?: string | null
          station?: string | null
          tenant_id?: string
          updated_at?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fuel_logs_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fuel_logs_logged_by_fkey"
            columns: ["logged_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fuel_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fuel_logs_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_investor_vehicle"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "fuel_logs_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "fuel_logs_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "fuel_logs_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      geofences: {
        Row: {
          charge_pence: number
          charge_type: Database["public"]["Enums"]["charge_type"]
          id: string
          is_active: boolean
          lat: number
          lng: number
          name: string
          radius_m: number
          tenant_id: string
        }
        Insert: {
          charge_pence?: number
          charge_type?: Database["public"]["Enums"]["charge_type"]
          id?: string
          is_active?: boolean
          lat: number
          lng: number
          name: string
          radius_m?: number
          tenant_id: string
        }
        Update: {
          charge_pence?: number
          charge_type?: Database["public"]["Enums"]["charge_type"]
          id?: string
          is_active?: boolean
          lat?: number
          lng?: number
          name?: string
          radius_m?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "geofences_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      hardware_events: {
        Row: {
          actor: string
          created_at: string
          detail: Json
          device_id: string | null
          id: string
          job_id: string | null
          kind: string
          tenant_id: string | null
          unit_id: string | null
        }
        Insert: {
          actor: string
          created_at?: string
          detail?: Json
          device_id?: string | null
          id?: string
          job_id?: string | null
          kind: string
          tenant_id?: string | null
          unit_id?: string | null
        }
        Update: {
          actor?: string
          created_at?: string
          detail?: Json
          device_id?: string | null
          id?: string
          job_id?: string | null
          kind?: string
          tenant_id?: string | null
          unit_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hardware_events_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "telematics_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hardware_events_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "hardware_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hardware_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hardware_events_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "device_units"
            referencedColumns: ["id"]
          },
        ]
      }
      hardware_jobs: {
        Row: {
          addon_ids: string[]
          address: string | null
          cancelled_at: string | null
          checklist: Json
          completed_at: string | null
          completed_by: string | null
          contact_name: string | null
          contact_phone: string | null
          created_at: string
          detail: Json
          device_id: string | null
          failure_reason: string | null
          fee_minor: number | null
          id: string
          installer_id: string | null
          invoice_id: string | null
          kind: string
          notes: string | null
          photos: Json
          replaced_device_id: string | null
          request_id: string | null
          scheduled_at: string | null
          sla_due_on: string | null
          source: string
          status: string
          tenant_id: string
          under_warranty: boolean | null
          unit_id: string | null
          updated_at: string
          vehicle_id: string | null
        }
        Insert: {
          addon_ids?: string[]
          address?: string | null
          cancelled_at?: string | null
          checklist?: Json
          completed_at?: string | null
          completed_by?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          detail?: Json
          device_id?: string | null
          failure_reason?: string | null
          fee_minor?: number | null
          id?: string
          installer_id?: string | null
          invoice_id?: string | null
          kind: string
          notes?: string | null
          photos?: Json
          replaced_device_id?: string | null
          request_id?: string | null
          scheduled_at?: string | null
          sla_due_on?: string | null
          source: string
          status?: string
          tenant_id: string
          under_warranty?: boolean | null
          unit_id?: string | null
          updated_at?: string
          vehicle_id?: string | null
        }
        Update: {
          addon_ids?: string[]
          address?: string | null
          cancelled_at?: string | null
          checklist?: Json
          completed_at?: string | null
          completed_by?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          detail?: Json
          device_id?: string | null
          failure_reason?: string | null
          fee_minor?: number | null
          id?: string
          installer_id?: string | null
          invoice_id?: string | null
          kind?: string
          notes?: string | null
          photos?: Json
          replaced_device_id?: string | null
          request_id?: string | null
          scheduled_at?: string | null
          sla_due_on?: string | null
          source?: string
          status?: string
          tenant_id?: string
          under_warranty?: boolean | null
          unit_id?: string | null
          updated_at?: string
          vehicle_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hardware_jobs_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "telematics_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hardware_jobs_installer_id_fkey"
            columns: ["installer_id"]
            isOneToOne: false
            referencedRelation: "installers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hardware_jobs_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "subscription_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hardware_jobs_replaced_device_id_fkey"
            columns: ["replaced_device_id"]
            isOneToOne: false
            referencedRelation: "telematics_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hardware_jobs_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "owner_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hardware_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hardware_jobs_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "device_units"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hardware_jobs_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_investor_vehicle"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "hardware_jobs_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "hardware_jobs_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "hardware_jobs_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      immobilisation_commands: {
        Row: {
          acked_at: string | null
          action: string
          created_at: string
          detail: Json | null
          device_id: string | null
          executed_by: string | null
          external_ref: string | null
          failure_reason: string | null
          id: string
          issued_by: string | null
          request_id: string | null
          sent_at: string | null
          speed_kph_at_send: number | null
          status: string
          tenant_id: string
          unit_id: string | null
          vehicle_id: string
        }
        Insert: {
          acked_at?: string | null
          action: string
          created_at?: string
          detail?: Json | null
          device_id?: string | null
          executed_by?: string | null
          external_ref?: string | null
          failure_reason?: string | null
          id?: string
          issued_by?: string | null
          request_id?: string | null
          sent_at?: string | null
          speed_kph_at_send?: number | null
          status?: string
          tenant_id: string
          unit_id?: string | null
          vehicle_id: string
        }
        Update: {
          acked_at?: string | null
          action?: string
          created_at?: string
          detail?: Json | null
          device_id?: string | null
          executed_by?: string | null
          external_ref?: string | null
          failure_reason?: string | null
          id?: string
          issued_by?: string | null
          request_id?: string | null
          sent_at?: string | null
          speed_kph_at_send?: number | null
          status?: string
          tenant_id?: string
          unit_id?: string | null
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "immobilisation_commands_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "telematics_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "immobilisation_commands_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "owner_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "immobilisation_commands_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "immobilisation_commands_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "device_units"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "immobilisation_commands_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_investor_vehicle"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "immobilisation_commands_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "immobilisation_commands_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "immobilisation_commands_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      installers: {
        Row: {
          active: boolean
          city: string | null
          created_at: string
          email: string | null
          fees: Json
          id: string
          kind: string
          name: string
          notes: string | null
          phone: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          city?: string | null
          created_at?: string
          email?: string | null
          fees?: Json
          id?: string
          kind?: string
          name: string
          notes?: string | null
          phone: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          city?: string | null
          created_at?: string
          email?: string | null
          fees?: Json
          id?: string
          kind?: string
          name?: string
          notes?: string | null
          phone?: string
          updated_at?: string
        }
        Relationships: []
      }
      insurance_certificates: {
        Row: {
          agreement_id: string | null
          company_interested_party: boolean
          cover_from: string
          cover_to: string
          created_at: string
          doc_path: string | null
          driver_id: string
          id: string
          insurer: string
          policy_no: string
          status: Database["public"]["Enums"]["cert_status"]
          tenant_id: string
          updated_at: string
          verified_by: string | null
          verified_on: string | null
        }
        Insert: {
          agreement_id?: string | null
          company_interested_party?: boolean
          cover_from: string
          cover_to: string
          created_at?: string
          doc_path?: string | null
          driver_id: string
          id?: string
          insurer: string
          policy_no: string
          status?: Database["public"]["Enums"]["cert_status"]
          tenant_id: string
          updated_at?: string
          verified_by?: string | null
          verified_on?: string | null
        }
        Update: {
          agreement_id?: string | null
          company_interested_party?: boolean
          cover_from?: string
          cover_to?: string
          created_at?: string
          doc_path?: string | null
          driver_id?: string
          id?: string
          insurer?: string
          policy_no?: string
          status?: Database["public"]["Enums"]["cert_status"]
          tenant_id?: string
          updated_at?: string
          verified_by?: string | null
          verified_on?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cert_agreement_fk"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "agreements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cert_agreement_fk"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_agreement_arrears"
            referencedColumns: ["agreement_id"]
          },
          {
            foreignKeyName: "cert_agreement_fk"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["active_agreement_id"]
          },
          {
            foreignKeyName: "cert_agreement_fk"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["active_agreement_id"]
          },
          {
            foreignKeyName: "insurance_certificates_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "insurance_certificates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          agreement_id: string
          created_at: string
          due_on: string
          gross_pence: number
          id: string
          issued_on: string
          net_pence: number
          number: string | null
          rent_schedule_id: string | null
          status: Database["public"]["Enums"]["invoice_status"]
          tenant_id: string
          updated_at: string
          vat_pence: number
        }
        Insert: {
          agreement_id: string
          created_at?: string
          due_on: string
          gross_pence: number
          id?: string
          issued_on?: string
          net_pence: number
          number?: string | null
          rent_schedule_id?: string | null
          status?: Database["public"]["Enums"]["invoice_status"]
          tenant_id: string
          updated_at?: string
          vat_pence: number
        }
        Update: {
          agreement_id?: string
          created_at?: string
          due_on?: string
          gross_pence?: number
          id?: string
          issued_on?: string
          net_pence?: number
          number?: string | null
          rent_schedule_id?: string | null
          status?: Database["public"]["Enums"]["invoice_status"]
          tenant_id?: string
          updated_at?: string
          vat_pence?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoices_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "agreements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_agreement_arrears"
            referencedColumns: ["agreement_id"]
          },
          {
            foreignKeyName: "invoices_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["active_agreement_id"]
          },
          {
            foreignKeyName: "invoices_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["active_agreement_id"]
          },
          {
            foreignKeyName: "invoices_rent_schedule_id_fkey"
            columns: ["rent_schedule_id"]
            isOneToOne: false
            referencedRelation: "rent_schedule"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      legal_acceptances: {
        Row: {
          accepted_at: string
          documents: string[]
          id: string
          ip: string | null
          tenant_id: string
          user_id: string
          version: string
        }
        Insert: {
          accepted_at?: string
          documents?: string[]
          id?: string
          ip?: string | null
          tenant_id: string
          user_id: string
          version: string
        }
        Update: {
          accepted_at?: string
          documents?: string[]
          id?: string
          ip?: string | null
          tenant_id?: string
          user_id?: string
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "legal_acceptances_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      login_codes: {
        Row: {
          attempts: number
          code_hash: string
          consumed_at: string | null
          created_at: string
          expires_at: string
          id: string
          phone: string
          requested_ip: string | null
        }
        Insert: {
          attempts?: number
          code_hash: string
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          id?: string
          phone: string
          requested_ip?: string | null
        }
        Update: {
          attempts?: number
          code_hash?: string
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          phone?: string
          requested_ip?: string | null
        }
        Relationships: []
      }
      maintenance_records: {
        Row: {
          cost_pence: number
          created_at: string
          description: string
          id: string
          odometer_miles: number | null
          payer: Database["public"]["Enums"]["maintenance_payer"]
          service_on: string
          tenant_id: string
          vehicle_id: string
        }
        Insert: {
          cost_pence?: number
          created_at?: string
          description: string
          id?: string
          odometer_miles?: number | null
          payer: Database["public"]["Enums"]["maintenance_payer"]
          service_on?: string
          tenant_id: string
          vehicle_id: string
        }
        Update: {
          cost_pence?: number
          created_at?: string
          description?: string
          id?: string
          odometer_miles?: number | null
          payer?: Database["public"]["Enums"]["maintenance_payer"]
          service_on?: string
          tenant_id?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_records_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_records_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_investor_vehicle"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "maintenance_records_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "maintenance_records_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "maintenance_records_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      maintenance_schedules: {
        Row: {
          created_at: string
          id: string
          interval_days: number
          is_active: boolean
          kind: string
          last_done_on: string | null
          next_due_on: string
          tenant_id: string
          updated_at: string
          vehicle_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          interval_days?: number
          is_active?: boolean
          kind?: string
          last_done_on?: string | null
          next_due_on: string
          tenant_id: string
          updated_at?: string
          vehicle_id: string
        }
        Update: {
          created_at?: string
          id?: string
          interval_days?: number
          is_active?: boolean
          kind?: string
          last_done_on?: string | null
          next_due_on?: string
          tenant_id?: string
          updated_at?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_schedules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_schedules_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_investor_vehicle"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "maintenance_schedules_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "maintenance_schedules_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "maintenance_schedules_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string
          channel: string
          created_at: string
          dedupe_key: string | null
          driver_id: string | null
          entity_id: string | null
          entity_type: string | null
          error: string | null
          id: string
          recipient: string | null
          status: string
          subject: string | null
          tenant_id: string
        }
        Insert: {
          body: string
          channel: string
          created_at?: string
          dedupe_key?: string | null
          driver_id?: string | null
          entity_id?: string | null
          entity_type?: string | null
          error?: string | null
          id?: string
          recipient?: string | null
          status: string
          subject?: string | null
          tenant_id: string
        }
        Update: {
          body?: string
          channel?: string
          created_at?: string
          dedupe_key?: string | null
          driver_id?: string | null
          entity_id?: string | null
          entity_type?: string | null
          error?: string | null
          id?: string
          recipient?: string | null
          status?: string
          subject?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      numbering_sequences: {
        Row: {
          current_value: number
          kind: string
          period: string
          tenant_id: string
        }
        Insert: {
          current_value?: number
          kind: string
          period: string
          tenant_id: string
        }
        Update: {
          current_value?: number
          kind?: string
          period?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "numbering_sequences_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      obligations: {
        Row: {
          created_at: string
          due_date: string
          entity_id: string
          entity_type: string
          id: string
          meta: Json | null
          resolved_on: string | null
          severity: Database["public"]["Enums"]["severity"]
          status: Database["public"]["Enums"]["obligation_status"]
          tenant_id: string
          title: string
          type: Database["public"]["Enums"]["obligation_type"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          due_date: string
          entity_id: string
          entity_type: string
          id?: string
          meta?: Json | null
          resolved_on?: string | null
          severity?: Database["public"]["Enums"]["severity"]
          status?: Database["public"]["Enums"]["obligation_status"]
          tenant_id: string
          title: string
          type: Database["public"]["Enums"]["obligation_type"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          due_date?: string
          entity_id?: string
          entity_type?: string
          id?: string
          meta?: Json | null
          resolved_on?: string | null
          severity?: Database["public"]["Enums"]["severity"]
          status?: Database["public"]["Enums"]["obligation_status"]
          tenant_id?: string
          title?: string
          type?: Database["public"]["Enums"]["obligation_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "obligations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      owner_reports: {
        Row: {
          data: Json
          generated_at: string
          id: string
          owner_id: string
          period: string
          sent_email_at: string | null
          sent_sms_at: string | null
          tenant_id: string
        }
        Insert: {
          data: Json
          generated_at?: string
          id?: string
          owner_id: string
          period: string
          sent_email_at?: string | null
          sent_sms_at?: string | null
          tenant_id: string
        }
        Update: {
          data?: Json
          generated_at?: string
          id?: string
          owner_id?: string
          period?: string
          sent_email_at?: string | null
          sent_sms_at?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "owner_reports_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "vehicle_owners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "owner_reports_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      owner_requests: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          closed_at: string | null
          closed_by: string | null
          created_at: string
          escalation_round: number
          id: string
          kind: string
          next_escalation_at: string | null
          note: string | null
          owner_id: string | null
          raised_by: string
          raised_role: string
          resolution: string | null
          status: string
          tenant_id: string
          vehicle_id: string | null
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          escalation_round?: number
          id?: string
          kind: string
          next_escalation_at?: string | null
          note?: string | null
          owner_id?: string | null
          raised_by: string
          raised_role: string
          resolution?: string | null
          status?: string
          tenant_id: string
          vehicle_id?: string | null
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          escalation_round?: number
          id?: string
          kind?: string
          next_escalation_at?: string | null
          note?: string | null
          owner_id?: string | null
          raised_by?: string
          raised_role?: string
          resolution?: string | null
          status?: string
          tenant_id?: string
          vehicle_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "owner_requests_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "vehicle_owners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "owner_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "owner_requests_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_investor_vehicle"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "owner_requests_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "owner_requests_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "owner_requests_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      owner_zones: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          lat: number
          lng: number
          name: string
          owner_id: string | null
          radius_m: number
          tenant_id: string
          vehicle_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          lat: number
          lng: number
          name: string
          owner_id?: string | null
          radius_m?: number
          tenant_id: string
          vehicle_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          lat?: number
          lng?: number
          name?: string
          owner_id?: string | null
          radius_m?: number
          tenant_id?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "owner_zones_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "vehicle_owners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "owner_zones_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "owner_zones_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_investor_vehicle"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "owner_zones_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "owner_zones_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "owner_zones_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_allocations: {
        Row: {
          amount_pence: number
          created_at: string
          id: string
          invoice_id: string
          payment_id: string
          tenant_id: string
        }
        Insert: {
          amount_pence: number
          created_at?: string
          id?: string
          invoice_id: string
          payment_id: string
          tenant_id: string
        }
        Update: {
          amount_pence?: number
          created_at?: string
          id?: string
          invoice_id?: string
          payment_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_allocations_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_allocations_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "v_invoice_balance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_allocations_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_allocations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          agreement_id: string | null
          amount_pence: number
          created_at: string
          driver_id: string | null
          external_ref: string | null
          id: string
          idempotency_key: string
          raw: Json | null
          received_on: string
          source: Database["public"]["Enums"]["payment_source"]
          status: Database["public"]["Enums"]["payment_status"]
          tenant_id: string
        }
        Insert: {
          agreement_id?: string | null
          amount_pence: number
          created_at?: string
          driver_id?: string | null
          external_ref?: string | null
          id?: string
          idempotency_key: string
          raw?: Json | null
          received_on?: string
          source: Database["public"]["Enums"]["payment_source"]
          status?: Database["public"]["Enums"]["payment_status"]
          tenant_id: string
        }
        Update: {
          agreement_id?: string | null
          amount_pence?: number
          created_at?: string
          driver_id?: string | null
          external_ref?: string | null
          id?: string
          idempotency_key?: string
          raw?: Json | null
          received_on?: string
          source?: Database["public"]["Enums"]["payment_source"]
          status?: Database["public"]["Enums"]["payment_status"]
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "agreements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_agreement_arrears"
            referencedColumns: ["agreement_id"]
          },
          {
            foreignKeyName: "payments_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["active_agreement_id"]
          },
          {
            foreignKeyName: "payments_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["active_agreement_id"]
          },
          {
            foreignKeyName: "payments_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      permitted_zones: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          lat: number
          lng: number
          name: string
          radius_m: number
          tenant_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          lat: number
          lng: number
          name: string
          radius_m?: number
          tenant_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          lat?: number
          lng?: number
          name?: string
          radius_m?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "permitted_zones_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      plan_features: {
        Row: {
          feature_key: string
          plan_id: string
        }
        Insert: {
          feature_key: string
          plan_id: string
        }
        Update: {
          feature_key?: string
          plan_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "plan_features_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
        ]
      }
      plan_included_addons: {
        Row: {
          addon_id: string
          plan_id: string
        }
        Insert: {
          addon_id: string
          plan_id: string
        }
        Update: {
          addon_id?: string
          plan_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "plan_included_addons_addon_id_fkey"
            columns: ["addon_id"]
            isOneToOne: false
            referencedRelation: "addons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_included_addons_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
        ]
      }
      plan_one_offs: {
        Row: {
          addon_id: string
          plan_id: string
        }
        Insert: {
          addon_id: string
          plan_id: string
        }
        Update: {
          addon_id?: string
          plan_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "plan_one_offs_addon_id_fkey"
            columns: ["addon_id"]
            isOneToOne: false
            referencedRelation: "addons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_one_offs_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
        ]
      }
      plans: {
        Row: {
          active: boolean
          additions_billing: string
          audience: string
          base_price_pence: number
          created_at: string
          description: string | null
          id: string
          interval: string
          key: string
          limits: Json
          name: string
          per_vehicle: boolean
          region: string | null
          sort: number
          stripe_price_id: string | null
          stripe_product_id: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          additions_billing?: string
          audience?: string
          base_price_pence?: number
          created_at?: string
          description?: string | null
          id?: string
          interval?: string
          key: string
          limits?: Json
          name: string
          per_vehicle?: boolean
          region?: string | null
          sort?: number
          stripe_price_id?: string | null
          stripe_product_id?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          additions_billing?: string
          audience?: string
          base_price_pence?: number
          created_at?: string
          description?: string | null
          id?: string
          interval?: string
          key?: string
          limits?: Json
          name?: string
          per_vehicle?: boolean
          region?: string | null
          sort?: number
          stripe_price_id?: string | null
          stripe_product_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      platform_admins: {
        Row: {
          added_at: string
          added_by: string | null
          user_id: string
        }
        Insert: {
          added_at?: string
          added_by?: string | null
          user_id: string
        }
        Update: {
          added_at?: string
          added_by?: string | null
          user_id?: string
        }
        Relationships: []
      }
      platform_metrics_daily: {
        Row: {
          arr_pence: number
          captured_at: string
          day: string
          mrr_pence: number
          paying_tenants: number
          tenants_active: number
          tenants_cancelled: number
          tenants_past_due: number
          tenants_total: number
          tenants_trialing: number
        }
        Insert: {
          arr_pence?: number
          captured_at?: string
          day: string
          mrr_pence?: number
          paying_tenants?: number
          tenants_active?: number
          tenants_cancelled?: number
          tenants_past_due?: number
          tenants_total?: number
          tenants_trialing?: number
        }
        Update: {
          arr_pence?: number
          captured_at?: string
          day?: string
          mrr_pence?: number
          paying_tenants?: number
          tenants_active?: number
          tenants_cancelled?: number
          tenants_past_due?: number
          tenants_total?: number
          tenants_trialing?: number
        }
        Relationships: []
      }
      platform_oncall: {
        Row: {
          active: boolean
          created_at: string
          id: string
          name: string
          phone: string
          priority: number
          user_id: string | null
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          name: string
          phone: string
          priority?: number
          user_id?: string | null
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          name?: string
          phone?: string
          priority?: number
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "platform_oncall_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_settings: {
        Row: {
          key: string
          updated_at: string
          updated_by: string | null
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          updated_by?: string | null
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          driver_id: string | null
          email: string | null
          full_name: string | null
          id: string
          phone: string | null
          role: Database["public"]["Enums"]["user_role"]
          updated_at: string
          vehicle_owner_id: string | null
        }
        Insert: {
          created_at?: string
          driver_id?: string | null
          email?: string | null
          full_name?: string | null
          id: string
          phone?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
          vehicle_owner_id?: string | null
        }
        Update: {
          created_at?: string
          driver_id?: string | null
          email?: string | null
          full_name?: string | null
          id?: string
          phone?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
          vehicle_owner_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_driver_fk"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_vehicle_owner_id_fkey"
            columns: ["vehicle_owner_id"]
            isOneToOne: false
            referencedRelation: "vehicle_owners"
            referencedColumns: ["id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          id: string
          last_used_at: string | null
          p256dh: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          id?: string
          last_used_at?: string | null
          p256dh: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          id?: string
          last_used_at?: string | null
          p256dh?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      rent_schedule: {
        Row: {
          agreement_id: string
          created_at: string
          gross_due_pence: number
          id: string
          net_due_pence: number
          period_end: string
          period_start: string
          status: Database["public"]["Enums"]["rent_status"]
          tenant_id: string
          updated_at: string
          vat_due_pence: number
          week_no: number
        }
        Insert: {
          agreement_id: string
          created_at?: string
          gross_due_pence: number
          id?: string
          net_due_pence: number
          period_end: string
          period_start: string
          status?: Database["public"]["Enums"]["rent_status"]
          tenant_id: string
          updated_at?: string
          vat_due_pence: number
          week_no: number
        }
        Update: {
          agreement_id?: string
          created_at?: string
          gross_due_pence?: number
          id?: string
          net_due_pence?: number
          period_end?: string
          period_start?: string
          status?: Database["public"]["Enums"]["rent_status"]
          tenant_id?: string
          updated_at?: string
          vat_due_pence?: number
          week_no?: number
        }
        Relationships: [
          {
            foreignKeyName: "rent_schedule_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "agreements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_schedule_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_agreement_arrears"
            referencedColumns: ["agreement_id"]
          },
          {
            foreignKeyName: "rent_schedule_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["active_agreement_id"]
          },
          {
            foreignKeyName: "rent_schedule_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["active_agreement_id"]
          },
          {
            foreignKeyName: "rent_schedule_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      rtb_equity_ledger: {
        Row: {
          agreement_id: string
          as_of: string
          created_at: string
          credit_pence: number
          cumulative_credit_pence: number
          deposit_pence: number
          equity_total_pence: number
          id: string
          tenant_id: string
          week_no: number
        }
        Insert: {
          agreement_id: string
          as_of: string
          created_at?: string
          credit_pence?: number
          cumulative_credit_pence: number
          deposit_pence?: number
          equity_total_pence: number
          id?: string
          tenant_id: string
          week_no: number
        }
        Update: {
          agreement_id?: string
          as_of?: string
          created_at?: string
          credit_pence?: number
          cumulative_credit_pence?: number
          deposit_pence?: number
          equity_total_pence?: number
          id?: string
          tenant_id?: string
          week_no?: number
        }
        Relationships: [
          {
            foreignKeyName: "rtb_equity_ledger_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "agreements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rtb_equity_ledger_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_agreement_arrears"
            referencedColumns: ["agreement_id"]
          },
          {
            foreignKeyName: "rtb_equity_ledger_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["active_agreement_id"]
          },
          {
            foreignKeyName: "rtb_equity_ledger_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["active_agreement_id"]
          },
          {
            foreignKeyName: "rtb_equity_ledger_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      signing_sessions: {
        Row: {
          agreement_id: string
          created_at: string
          created_by: string | null
          deposit_pence: number
          driver_name: string | null
          driver_signed_at: string | null
          driver_token: string
          id: string
          partner_approved_at: string | null
          partner_name: string | null
          partner_token: string
          per_mile_pence: number
          reference: string
          signed_html: string | null
          signer_ip: string | null
          start_mileage: string | null
          status: Database["public"]["Enums"]["signing_status"]
          tenant_id: string
          updated_at: string
          vehicle_value_pence: number | null
          weekly_gross_pence: number
        }
        Insert: {
          agreement_id: string
          created_at?: string
          created_by?: string | null
          deposit_pence: number
          driver_name?: string | null
          driver_signed_at?: string | null
          driver_token: string
          id?: string
          partner_approved_at?: string | null
          partner_name?: string | null
          partner_token: string
          per_mile_pence?: number
          reference: string
          signed_html?: string | null
          signer_ip?: string | null
          start_mileage?: string | null
          status?: Database["public"]["Enums"]["signing_status"]
          tenant_id: string
          updated_at?: string
          vehicle_value_pence?: number | null
          weekly_gross_pence: number
        }
        Update: {
          agreement_id?: string
          created_at?: string
          created_by?: string | null
          deposit_pence?: number
          driver_name?: string | null
          driver_signed_at?: string | null
          driver_token?: string
          id?: string
          partner_approved_at?: string | null
          partner_name?: string | null
          partner_token?: string
          per_mile_pence?: number
          reference?: string
          signed_html?: string | null
          signer_ip?: string | null
          start_mileage?: string | null
          status?: Database["public"]["Enums"]["signing_status"]
          tenant_id?: string
          updated_at?: string
          vehicle_value_pence?: number | null
          weekly_gross_pence?: number
        }
        Relationships: [
          {
            foreignKeyName: "signing_sessions_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "agreements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signing_sessions_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_agreement_arrears"
            referencedColumns: ["agreement_id"]
          },
          {
            foreignKeyName: "signing_sessions_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["active_agreement_id"]
          },
          {
            foreignKeyName: "signing_sessions_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["active_agreement_id"]
          },
          {
            foreignKeyName: "signing_sessions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signing_sessions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      subscription_events: {
        Row: {
          actor: string
          created_at: string
          detail: Json
          id: string
          invoice_id: string | null
          kind: string
          tenant_id: string
        }
        Insert: {
          actor: string
          created_at?: string
          detail?: Json
          id?: string
          invoice_id?: string | null
          kind: string
          tenant_id: string
        }
        Update: {
          actor?: string
          created_at?: string
          detail?: Json
          id?: string
          invoice_id?: string | null
          kind?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscription_events_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "subscription_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscription_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      subscription_invoice_counters: {
        Row: {
          last: number
          year: number
        }
        Insert: {
          last?: number
          year: number
        }
        Update: {
          last?: number
          year?: number
        }
        Relationships: []
      }
      subscription_invoice_lines: {
        Row: {
          addon_id: string | null
          description: string
          gross_minor: number
          id: string
          invoice_id: string
          kind: string
          net_minor: number
          period_end: string | null
          period_start: string | null
          plan_id: string | null
          quantity: number
          sort: number
          tenant_id: string
          unit_minor: number
          vat_minor: number
          vat_rate: number
          vehicle_id: string | null
        }
        Insert: {
          addon_id?: string | null
          description: string
          gross_minor: number
          id?: string
          invoice_id: string
          kind: string
          net_minor: number
          period_end?: string | null
          period_start?: string | null
          plan_id?: string | null
          quantity: number
          sort?: number
          tenant_id: string
          unit_minor: number
          vat_minor: number
          vat_rate: number
          vehicle_id?: string | null
        }
        Update: {
          addon_id?: string | null
          description?: string
          gross_minor?: number
          id?: string
          invoice_id?: string
          kind?: string
          net_minor?: number
          period_end?: string | null
          period_start?: string | null
          plan_id?: string | null
          quantity?: number
          sort?: number
          tenant_id?: string
          unit_minor?: number
          vat_minor?: number
          vat_rate?: number
          vehicle_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "subscription_invoice_lines_addon_id_fkey"
            columns: ["addon_id"]
            isOneToOne: false
            referencedRelation: "addons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscription_invoice_lines_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "subscription_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscription_invoice_lines_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscription_invoice_lines_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscription_invoice_lines_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_investor_vehicle"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "subscription_invoice_lines_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "subscription_invoice_lines_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "subscription_invoice_lines_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      subscription_invoices: {
        Row: {
          created_at: string
          currency: string
          customer: Json
          data: Json
          due_on: string
          gross_minor: number
          id: string
          issued_on: string
          issuer: Json
          kind: string
          net_minor: number
          number: string
          paid_at: string | null
          paid_minor: number
          pay_token: string
          period_end: string | null
          period_start: string | null
          plan_id: string | null
          status: string
          tenant_id: string
          updated_at: string
          vat_minor: number
          void_reason: string | null
          voided_at: string | null
          wht_minor: number
        }
        Insert: {
          created_at?: string
          currency: string
          customer?: Json
          data?: Json
          due_on: string
          gross_minor: number
          id?: string
          issued_on?: string
          issuer?: Json
          kind: string
          net_minor: number
          number: string
          paid_at?: string | null
          paid_minor?: number
          pay_token: string
          period_end?: string | null
          period_start?: string | null
          plan_id?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
          vat_minor: number
          void_reason?: string | null
          voided_at?: string | null
          wht_minor?: number
        }
        Update: {
          created_at?: string
          currency?: string
          customer?: Json
          data?: Json
          due_on?: string
          gross_minor?: number
          id?: string
          issued_on?: string
          issuer?: Json
          kind?: string
          net_minor?: number
          number?: string
          paid_at?: string | null
          paid_minor?: number
          pay_token?: string
          period_end?: string | null
          period_start?: string | null
          plan_id?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
          vat_minor?: number
          void_reason?: string | null
          voided_at?: string | null
          wht_minor?: number
        }
        Relationships: [
          {
            foreignKeyName: "subscription_invoices_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscription_invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      subscription_payments: {
        Row: {
          amount_minor: number
          confirmed_at: string | null
          created_at: string
          currency: string
          external_ref: string | null
          id: string
          invoice_id: string
          note: string | null
          raw: Json | null
          received_on: string | null
          reference: string
          source: string
          status: string
          tenant_id: string
          verified_by: string | null
        }
        Insert: {
          amount_minor: number
          confirmed_at?: string | null
          created_at?: string
          currency: string
          external_ref?: string | null
          id?: string
          invoice_id: string
          note?: string | null
          raw?: Json | null
          received_on?: string | null
          reference: string
          source: string
          status?: string
          tenant_id: string
          verified_by?: string | null
        }
        Update: {
          amount_minor?: number
          confirmed_at?: string | null
          created_at?: string
          currency?: string
          external_ref?: string | null
          id?: string
          invoice_id?: string
          note?: string | null
          raw?: Json | null
          received_on?: string | null
          reference?: string
          source?: string
          status?: string
          tenant_id?: string
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "subscription_payments_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "subscription_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscription_payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      subscription_reminders: {
        Row: {
          channel: string | null
          detail: string | null
          id: string
          kind: string
          period_end: string | null
          recipient: string | null
          sent_at: string
          status: string
          tenant_id: string
        }
        Insert: {
          channel?: string | null
          detail?: string | null
          id?: string
          kind: string
          period_end?: string | null
          recipient?: string | null
          sent_at?: string
          status?: string
          tenant_id: string
        }
        Update: {
          channel?: string | null
          detail?: string | null
          id?: string
          kind?: string
          period_end?: string | null
          recipient?: string | null
          sent_at?: string
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscription_reminders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      telematics_devices: {
        Row: {
          created_at: string
          device_token: string
          first_ping_at: string | null
          fitted_at: string | null
          id: string
          installer_id: string | null
          is_active: boolean
          kind: string
          label: string | null
          removed_at: string | null
          removed_reason: string | null
          state: string
          tenant_id: string
          unit_id: string | null
          vehicle_id: string
          warranty_until: string | null
        }
        Insert: {
          created_at?: string
          device_token: string
          first_ping_at?: string | null
          fitted_at?: string | null
          id?: string
          installer_id?: string | null
          is_active?: boolean
          kind?: string
          label?: string | null
          removed_at?: string | null
          removed_reason?: string | null
          state?: string
          tenant_id: string
          unit_id?: string | null
          vehicle_id: string
          warranty_until?: string | null
        }
        Update: {
          created_at?: string
          device_token?: string
          first_ping_at?: string | null
          fitted_at?: string | null
          id?: string
          installer_id?: string | null
          is_active?: boolean
          kind?: string
          label?: string | null
          removed_at?: string | null
          removed_reason?: string | null
          state?: string
          tenant_id?: string
          unit_id?: string | null
          vehicle_id?: string
          warranty_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "telematics_devices_installer_id_fkey"
            columns: ["installer_id"]
            isOneToOne: false
            referencedRelation: "installers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telematics_devices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telematics_devices_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "device_units"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telematics_devices_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_investor_vehicle"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "telematics_devices_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "telematics_devices_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "telematics_devices_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_addons: {
        Row: {
          activated_at: string
          addon_id: string
          cancelled_at: string | null
          deposit_state: string
          id: string
          quantity: number
          status: string
          tenant_id: string
        }
        Insert: {
          activated_at?: string
          addon_id: string
          cancelled_at?: string | null
          deposit_state?: string
          id?: string
          quantity?: number
          status?: string
          tenant_id: string
        }
        Update: {
          activated_at?: string
          addon_id?: string
          cancelled_at?: string | null
          deposit_state?: string
          id?: string
          quantity?: number
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_addons_addon_id_fkey"
            columns: ["addon_id"]
            isOneToOne: false
            referencedRelation: "addons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_addons_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_ai_config: {
        Row: {
          enabled: boolean
          model: string | null
          provider: string
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          enabled?: boolean
          model?: string | null
          provider?: string
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          enabled?: boolean
          model?: string | null
          provider?: string
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_ai_config_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_ai_secrets: {
        Row: {
          auth_tag: string
          ciphertext: string
          iv: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          auth_tag: string
          ciphertext: string
          iv: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          auth_tag?: string
          ciphertext?: string
          iv?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_ai_secrets_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_ai_usage: {
        Row: {
          period_month: string
          tenant_id: string
          tokens_in: number
          tokens_out: number
          updated_at: string
        }
        Insert: {
          period_month: string
          tenant_id: string
          tokens_in?: number
          tokens_out?: number
          updated_at?: string
        }
        Update: {
          period_month?: string
          tenant_id?: string
          tokens_in?: number
          tokens_out?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_ai_usage_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_billing: {
        Row: {
          current_period_end: string | null
          price_id: string | null
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          subscription_status: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          current_period_end?: string | null
          price_id?: string | null
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_status?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          current_period_end?: string | null
          price_id?: string | null
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_status?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_billing_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_email_config: {
        Row: {
          email_enabled: boolean
          from_address: string | null
          from_name: string | null
          provider: string
          reply_to: string | null
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          email_enabled?: boolean
          from_address?: string | null
          from_name?: string | null
          provider?: string
          reply_to?: string | null
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          email_enabled?: boolean
          from_address?: string | null
          from_name?: string | null
          provider?: string
          reply_to?: string | null
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_email_config_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_email_secrets: {
        Row: {
          auth_tag: string
          ciphertext: string
          iv: string
          kind: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          auth_tag: string
          ciphertext: string
          iv: string
          kind: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          auth_tag?: string
          ciphertext?: string
          iv?: string
          kind?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_email_secrets_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_memberships: {
        Row: {
          created_at: string
          id: string
          permissions: string[]
          role: string
          status: Database["public"]["Enums"]["membership_status"]
          tenant_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          permissions?: string[]
          role?: string
          status?: Database["public"]["Enums"]["membership_status"]
          tenant_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          permissions?: string[]
          role?: string
          status?: Database["public"]["Enums"]["membership_status"]
          tenant_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_memberships_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_memberships_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_payment_config: {
        Row: {
          gocardless_enabled: boolean
          gocardless_environment: string
          stripe_enabled: boolean
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          gocardless_enabled?: boolean
          gocardless_environment?: string
          stripe_enabled?: boolean
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          gocardless_enabled?: boolean
          gocardless_environment?: string
          stripe_enabled?: boolean
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_payment_config_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_payment_secrets: {
        Row: {
          auth_tag: string
          ciphertext: string
          iv: string
          kind: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          auth_tag: string
          ciphertext: string
          iv: string
          kind: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          auth_tag?: string
          ciphertext?: string
          iv?: string
          kind?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_payment_secrets_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_signup_requests: {
        Row: {
          company: string
          contact_name: string | null
          created_at: string
          email: string
          fleet_size: string | null
          id: string
          message: string | null
          phone: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          tenant_id: string | null
          terms_version: string | null
        }
        Insert: {
          company: string
          contact_name?: string | null
          created_at?: string
          email: string
          fleet_size?: string | null
          id?: string
          message?: string | null
          phone?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          tenant_id?: string | null
          terms_version?: string | null
        }
        Update: {
          company?: string
          contact_name?: string | null
          created_at?: string
          email?: string
          fleet_size?: string | null
          id?: string
          message?: string | null
          phone?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          tenant_id?: string | null
          terms_version?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_signup_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_sms_config: {
        Row: {
          account_sid: string | null
          from_number: string | null
          provider: string
          sms_enabled: boolean
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          account_sid?: string | null
          from_number?: string | null
          provider?: string
          sms_enabled?: boolean
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          account_sid?: string | null
          from_number?: string | null
          provider?: string
          sms_enabled?: boolean
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_sms_config_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_sms_secrets: {
        Row: {
          auth_tag: string
          ciphertext: string
          iv: string
          kind: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          auth_tag: string
          ciphertext: string
          iv: string
          kind: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          auth_tag?: string
          ciphertext?: string
          iv?: string
          kind?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_sms_secrets_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_subscription: {
        Row: {
          activated_at: string | null
          anniversary_on: string | null
          billed_vehicles: number
          billing_address: string | null
          billing_email: string | null
          billing_name: string | null
          billing_phone: string | null
          cancelled_at: string | null
          current_period_end: string | null
          current_period_start: string | null
          customer_tin: string | null
          past_due_since: string | null
          pending_plan_id: string | null
          plan_id: string | null
          status: string
          suspended_at: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          activated_at?: string | null
          anniversary_on?: string | null
          billed_vehicles?: number
          billing_address?: string | null
          billing_email?: string | null
          billing_name?: string | null
          billing_phone?: string | null
          cancelled_at?: string | null
          current_period_end?: string | null
          current_period_start?: string | null
          customer_tin?: string | null
          past_due_since?: string | null
          pending_plan_id?: string | null
          plan_id?: string | null
          status?: string
          suspended_at?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          activated_at?: string | null
          anniversary_on?: string | null
          billed_vehicles?: number
          billing_address?: string | null
          billing_email?: string | null
          billing_name?: string | null
          billing_phone?: string | null
          cancelled_at?: string | null
          current_period_end?: string | null
          current_period_start?: string | null
          customer_tin?: string | null
          past_due_since?: string | null
          pending_plan_id?: string | null
          plan_id?: string | null
          status?: string
          suspended_at?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_subscription_pending_plan_id_fkey"
            columns: ["pending_plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_subscription_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_subscription_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_tracking_rules: {
        Row: {
          allowed_from: string | null
          allowed_to: string | null
          no_booking_movement_enabled: boolean
          out_of_hours_enabled: boolean
          permitted_area_enabled: boolean
          tenant_id: string
          timezone: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          allowed_from?: string | null
          allowed_to?: string | null
          no_booking_movement_enabled?: boolean
          out_of_hours_enabled?: boolean
          permitted_area_enabled?: boolean
          tenant_id: string
          timezone?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          allowed_from?: string | null
          allowed_to?: string | null
          no_booking_movement_enabled?: boolean
          out_of_hours_enabled?: boolean
          permitted_area_enabled?: boolean
          tenant_id?: string
          timezone?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_tracking_rules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          branding: Json
          created_at: string
          id: string
          modules: Json
          name: string
          plan: Database["public"]["Enums"]["tenant_plan"]
          ref_prefixes: Json
          slug: string
          status: Database["public"]["Enums"]["tenant_status"]
          updated_at: string
        }
        Insert: {
          branding?: Json
          created_at?: string
          id?: string
          modules?: Json
          name: string
          plan?: Database["public"]["Enums"]["tenant_plan"]
          ref_prefixes?: Json
          slug: string
          status?: Database["public"]["Enums"]["tenant_status"]
          updated_at?: string
        }
        Update: {
          branding?: Json
          created_at?: string
          id?: string
          modules?: Json
          name?: string
          plan?: Database["public"]["Enums"]["tenant_plan"]
          ref_prefixes?: Json
          slug?: string
          status?: Database["public"]["Enums"]["tenant_status"]
          updated_at?: string
        }
        Relationships: []
      }
      tfl_uploads: {
        Row: {
          id: string
          note: string | null
          period: string
          tenant_id: string
          uploaded_at: string
          uploaded_by: string | null
        }
        Insert: {
          id?: string
          note?: string | null
          period: string
          tenant_id: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Update: {
          id?: string
          note?: string | null
          period?: string
          tenant_id?: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tfl_uploads_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tfl_uploads_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_alerts: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          created_at: string
          dedupe_key: string
          detail: Json
          id: string
          kind: Database["public"]["Enums"]["alert_kind"]
          lat: number | null
          lng: number | null
          notified_push_at: string | null
          notified_sms_at: string | null
          occurred_at: string
          owner_id: string | null
          severity: string
          speed_kph: number | null
          tenant_id: string
          vehicle_id: string
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          created_at?: string
          dedupe_key: string
          detail?: Json
          id?: string
          kind: Database["public"]["Enums"]["alert_kind"]
          lat?: number | null
          lng?: number | null
          notified_push_at?: string | null
          notified_sms_at?: string | null
          occurred_at: string
          owner_id?: string | null
          severity: string
          speed_kph?: number | null
          tenant_id: string
          vehicle_id: string
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          created_at?: string
          dedupe_key?: string
          detail?: Json
          id?: string
          kind?: Database["public"]["Enums"]["alert_kind"]
          lat?: number | null
          lng?: number | null
          notified_push_at?: string | null
          notified_sms_at?: string | null
          occurred_at?: string
          owner_id?: string | null
          severity?: string
          speed_kph?: number | null
          tenant_id?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_alerts_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "vehicle_owners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_alerts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_alerts_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_investor_vehicle"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "vehicle_alerts_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "vehicle_alerts_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "vehicle_alerts_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_compliance: {
        Row: {
          created_at: string
          doc_path: string | null
          expires_on: string | null
          id: string
          issued_on: string | null
          note: string | null
          obligation_key: string
          reference: string | null
          tenant_id: string
          updated_at: string
          updated_by: string | null
          vehicle_id: string
        }
        Insert: {
          created_at?: string
          doc_path?: string | null
          expires_on?: string | null
          id?: string
          issued_on?: string | null
          note?: string | null
          obligation_key: string
          reference?: string | null
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
          vehicle_id: string
        }
        Update: {
          created_at?: string
          doc_path?: string | null
          expires_on?: string | null
          id?: string
          issued_on?: string | null
          note?: string | null
          obligation_key?: string
          reference?: string | null
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_compliance_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_compliance_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_compliance_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_investor_vehicle"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "vehicle_compliance_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "vehicle_compliance_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "vehicle_compliance_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_owners: {
        Row: {
          alerts_sms: boolean
          created_at: string
          email: string | null
          id: string
          name: string
          night_from: string
          night_to: string
          nin: string | null
          offline_after_h: number
          phone: string
          speed_limit_kph: number
          tenant_id: string
          timezone: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          alerts_sms?: boolean
          created_at?: string
          email?: string | null
          id?: string
          name: string
          night_from?: string
          night_to?: string
          nin?: string | null
          offline_after_h?: number
          phone: string
          speed_limit_kph?: number
          tenant_id: string
          timezone?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          alerts_sms?: boolean
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          night_from?: string
          night_to?: string
          nin?: string | null
          offline_after_h?: number
          phone?: string
          speed_limit_kph?: number
          tenant_id?: string
          timezone?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_owners_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_owners_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_position_history: {
        Row: {
          battery_pct: number | null
          booking_id: string | null
          driver_id: string | null
          heading: number | null
          id: number
          lat: number
          lng: number
          odometer_miles: number | null
          range_miles: number | null
          recorded_at: string
          speed_mph: number | null
          tenant_id: string
          vehicle_id: string
        }
        Insert: {
          battery_pct?: number | null
          booking_id?: string | null
          driver_id?: string | null
          heading?: number | null
          id?: number
          lat: number
          lng: number
          odometer_miles?: number | null
          range_miles?: number | null
          recorded_at?: string
          speed_mph?: number | null
          tenant_id: string
          vehicle_id: string
        }
        Update: {
          battery_pct?: number | null
          booking_id?: string | null
          driver_id?: string | null
          heading?: number | null
          id?: number
          lat?: number
          lng?: number
          odometer_miles?: number | null
          range_miles?: number | null
          recorded_at?: string
          speed_mph?: number | null
          tenant_id?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_position_history_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_position_history_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_position_history_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_position_history_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_investor_vehicle"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "vehicle_position_history_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "vehicle_position_history_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "vehicle_position_history_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_positions: {
        Row: {
          battery_pct: number | null
          booking_id: string | null
          heading: number | null
          lat: number
          lng: number
          odometer_miles: number | null
          range_miles: number | null
          recorded_at: string
          speed_mph: number | null
          tenant_id: string
          updated_at: string
          vehicle_id: string
        }
        Insert: {
          battery_pct?: number | null
          booking_id?: string | null
          heading?: number | null
          lat: number
          lng: number
          odometer_miles?: number | null
          range_miles?: number | null
          recorded_at?: string
          speed_mph?: number | null
          tenant_id: string
          updated_at?: string
          vehicle_id: string
        }
        Update: {
          battery_pct?: number | null
          booking_id?: string | null
          heading?: number | null
          lat?: number
          lng?: number
          odometer_miles?: number | null
          range_miles?: number | null
          recorded_at?: string
          speed_mph?: number | null
          tenant_id?: string
          updated_at?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_positions_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_positions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_positions_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: true
            referencedRelation: "v_investor_vehicle"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "vehicle_positions_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: true
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "vehicle_positions_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: true
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "vehicle_positions_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: true
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicles: {
        Row: {
          acquired_on: string | null
          baseline_km_per_litre: number | null
          co2_gkm: number | null
          colour: string | null
          created_at: string
          ev_range_miles: number | null
          fuel: Database["public"]["Enums"]["fuel_type"]
          id: string
          last_service_miles: number | null
          list_value_pence: number
          make: string
          model: string
          model_year: number | null
          mot_due_on: string | null
          notes: string | null
          owner_id: string | null
          registration: string
          residual_estimate_pence: number | null
          service_interval_miles: number | null
          status: Database["public"]["Enums"]["vehicle_status"]
          tank_capacity_litres: number | null
          tenant_id: string
          updated_at: string
          ved_annual_pence: number
          ved_renewal_on: string | null
          vin: string | null
        }
        Insert: {
          acquired_on?: string | null
          baseline_km_per_litre?: number | null
          co2_gkm?: number | null
          colour?: string | null
          created_at?: string
          ev_range_miles?: number | null
          fuel?: Database["public"]["Enums"]["fuel_type"]
          id?: string
          last_service_miles?: number | null
          list_value_pence: number
          make?: string
          model?: string
          model_year?: number | null
          mot_due_on?: string | null
          notes?: string | null
          owner_id?: string | null
          registration: string
          residual_estimate_pence?: number | null
          service_interval_miles?: number | null
          status?: Database["public"]["Enums"]["vehicle_status"]
          tank_capacity_litres?: number | null
          tenant_id: string
          updated_at?: string
          ved_annual_pence?: number
          ved_renewal_on?: string | null
          vin?: string | null
        }
        Update: {
          acquired_on?: string | null
          baseline_km_per_litre?: number | null
          co2_gkm?: number | null
          colour?: string | null
          created_at?: string
          ev_range_miles?: number | null
          fuel?: Database["public"]["Enums"]["fuel_type"]
          id?: string
          last_service_miles?: number | null
          list_value_pence?: number
          make?: string
          model?: string
          model_year?: number | null
          mot_due_on?: string | null
          notes?: string | null
          owner_id?: string | null
          registration?: string
          residual_estimate_pence?: number | null
          service_interval_miles?: number | null
          status?: Database["public"]["Enums"]["vehicle_status"]
          tank_capacity_litres?: number | null
          tenant_id?: string
          updated_at?: string
          ved_annual_pence?: number
          ved_renewal_on?: string | null
          vin?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vehicles_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "vehicle_owners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      void_events: {
        Row: {
          created_at: string
          end_on: string | null
          id: string
          reason: string
          start_on: string
          tenant_id: string
          vehicle_id: string
        }
        Insert: {
          created_at?: string
          end_on?: string | null
          id?: string
          reason: string
          start_on: string
          tenant_id: string
          vehicle_id: string
        }
        Update: {
          created_at?: string
          end_on?: string | null
          id?: string
          reason?: string
          start_on?: string
          tenant_id?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "void_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "void_events_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_investor_vehicle"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "void_events_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "void_events_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "void_events_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      v_agreement_arrears: {
        Row: {
          agreement_id: string | null
          billed_pence: number | null
          collected_pence: number | null
          driver_id: string | null
          outstanding_pence: number | null
          vehicle_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agreements_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agreements_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_investor_vehicle"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "agreements_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "agreements_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["vehicle_id"]
          },
          {
            foreignKeyName: "agreements_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      v_investor_fleet: {
        Row: {
          avg_occupancy_pct: number | null
          contracted_annual_profit_pence: number | null
          net_received_to_date_pence: number | null
          on_hire: number | null
          vehicles: number | null
        }
        Relationships: []
      }
      v_investor_vehicle: {
        Row: {
          agreement_type: Database["public"]["Enums"]["agreement_type"] | null
          annual_lease_pence: number | null
          contracted_annual_net_pence: number | null
          contracted_annual_profit_pence: number | null
          gfv_due_on: string | null
          gfv_status: Database["public"]["Enums"]["gfv_status"] | null
          maintenance_12m_pence: number | null
          net_received_to_date_pence: number | null
          occupancy_12m_pct: number | null
          registration: string | null
          status: Database["public"]["Enums"]["vehicle_status"] | null
          ved_annual_pence: number | null
          vehicle_id: string | null
        }
        Relationships: []
      }
      v_invoice_balance: {
        Row: {
          agreement_id: string | null
          allocated_pence: number | null
          balance_pence: number | null
          created_at: string | null
          due_on: string | null
          gross_pence: number | null
          id: string | null
          is_overdue: boolean | null
          issued_on: string | null
          net_pence: number | null
          number: string | null
          rent_schedule_id: string | null
          status: Database["public"]["Enums"]["invoice_status"] | null
          updated_at: string | null
          vat_pence: number | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "agreements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_agreement_arrears"
            referencedColumns: ["agreement_id"]
          },
          {
            foreignKeyName: "invoices_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["active_agreement_id"]
          },
          {
            foreignKeyName: "invoices_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["active_agreement_id"]
          },
          {
            foreignKeyName: "invoices_rent_schedule_id_fkey"
            columns: ["rent_schedule_id"]
            isOneToOne: false
            referencedRelation: "rent_schedule"
            referencedColumns: ["id"]
          },
        ]
      }
      v_receipt_vat: {
        Row: {
          agreement_id: string | null
          allocation_id: string | null
          gross_pence: number | null
          received_on: string | null
          vat_pence: number | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "agreements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_agreement_arrears"
            referencedColumns: ["agreement_id"]
          },
          {
            foreignKeyName: "invoices_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics"
            referencedColumns: ["active_agreement_id"]
          },
          {
            foreignKeyName: "invoices_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "v_vehicle_economics_all"
            referencedColumns: ["active_agreement_id"]
          },
        ]
      }
      v_vat_by_quarter: {
        Row: {
          gross_received_pence: number | null
          input_vat_maintenance_pence: number | null
          net_vat_pence: number | null
          output_vat_pence: number | null
          quarter_start: string | null
        }
        Relationships: []
      }
      v_vat_by_quarter_tenant: {
        Row: {
          gross_received_pence: number | null
          input_vat_maintenance_pence: number | null
          net_vat_pence: number | null
          output_vat_pence: number | null
          quarter_start: string | null
          tenant_id: string | null
        }
        Relationships: []
      }
      v_vehicle_economics: {
        Row: {
          active_agreement_id: string | null
          agreement_type: Database["public"]["Enums"]["agreement_type"] | null
          annual_lease_pence: number | null
          contracted_annual_net_pence: number | null
          contracted_annual_profit_pence: number | null
          driver_id: string | null
          gfv_amount_pence: number | null
          gfv_due_on: string | null
          gfv_status: Database["public"]["Enums"]["gfv_status"] | null
          maintenance_12m_pence: number | null
          net_received_to_date_pence: number | null
          occupancy_12m_pct: number | null
          registration: string | null
          status: Database["public"]["Enums"]["vehicle_status"] | null
          ved_annual_pence: number | null
          vehicle_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agreements_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
      }
      v_vehicle_economics_all: {
        Row: {
          active_agreement_id: string | null
          agreement_type: Database["public"]["Enums"]["agreement_type"] | null
          annual_lease_pence: number | null
          contracted_annual_net_pence: number | null
          contracted_annual_profit_pence: number | null
          driver_id: string | null
          gfv_amount_pence: number | null
          gfv_due_on: string | null
          gfv_status: Database["public"]["Enums"]["gfv_status"] | null
          maintenance_12m_pence: number | null
          net_received_to_date_pence: number | null
          occupancy_12m_pct: number | null
          registration: string | null
          status: Database["public"]["Enums"]["vehicle_status"] | null
          ved_annual_pence: number | null
          vehicle_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agreements_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      add_ai_usage: {
        Args: { p_in: number; p_month: string; p_out: number; p_tenant: string }
        Returns: undefined
      }
      auth_role: {
        Args: never
        Returns: Database["public"]["Enums"]["user_role"]
      }
      current_app_tenant: { Args: never; Returns: string }
      current_app_user: { Args: never; Returns: string }
      current_driver_id: { Args: never; Returns: string }
      current_vehicle_owner_id: { Args: never; Returns: string }
      fn_vehicle_occupancy_pct: {
        Args: { p_from: string; p_to: string; p_vehicle: string }
        Returns: number
      }
      fn_vehicle_occupied_days: {
        Args: { p_from: string; p_to: string; p_vehicle: string }
        Returns: number
      }
      is_ops: { Args: never; Returns: boolean }
      is_platform_admin: { Args: never; Returns: boolean }
      is_tenant_member: { Args: { tid: string }; Returns: boolean }
      log_audit: {
        Args: {
          p_action: string
          p_actor?: string
          p_detail?: Json
          p_entity_id?: string
          p_entity_type?: string
          p_tenant: string
        }
        Returns: number
      }
      next_ref: { Args: { p_kind: string; p_tenant: string }; Returns: string }
      next_subscription_invoice_number: { Args: never; Returns: string }
      owns_agreement: { Args: { p_agreement: string }; Returns: boolean }
      owns_vehicle: { Args: { p_vehicle: string }; Returns: boolean }
      vehicle_movement_summary: {
        Args: { p_from: string; p_to: string; p_vehicle: string }
        Returns: {
          distance_m: number
          longest_gap_minutes: number
          moving_minutes: number
          pings: number
          trips: number
        }[]
      }
    }
    Enums: {
      agreement_status:
        | "draft"
        | "pending_signature"
        | "active"
        | "ended"
        | "defaulted"
        | "transferred"
      agreement_type: "standard" | "rtb"
      alert_kind:
        | "speeding"
        | "night_movement"
        | "zone_exit"
        | "device_offline"
        | "immobilised"
        | "released"
      booking_source: "dispatch" | "app" | "job_sheet"
      booking_status:
        | "requested"
        | "assigned"
        | "en_route"
        | "in_progress"
        | "completed"
        | "cancelled"
        | "no_show"
      cert_status: "pending" | "verified" | "rejected" | "expired"
      charge_status:
        | "received"
        | "driver_notified"
        | "driver_liable"
        | "disputed"
        | "paid_by_driver"
        | "paid_by_company"
        | "cancelled"
      charge_type:
        | "pcn"
        | "congestion"
        | "ulez"
        | "dartford"
        | "toll"
        | "other"
        | "airport"
      deposit_event: "held" | "deducted" | "refunded" | "forfeited"
      driver_status: "lead" | "vetting" | "active" | "suspended" | "terminated"
      fuel_payment_method:
        | "cash"
        | "card"
        | "fuel_card"
        | "company_account"
        | "other"
      fuel_type: "phev" | "ev" | "petrol" | "diesel" | "hybrid"
      gfv_status: "unconfirmed" | "confirmed" | "settled" | "na"
      invoice_status: "open" | "paid" | "part_paid" | "void" | "overdue"
      maintenance_payer: "company" | "driver"
      membership_status: "active" | "invited" | "disabled"
      obligation_status:
        | "open"
        | "due_soon"
        | "overdue"
        | "resolved"
        | "dismissed"
      obligation_type:
        | "insurance_expiry"
        | "pco_licence_expiry"
        | "dvla_check"
        | "mot"
        | "ved_renewal"
        | "gfv_settlement"
        | "agreement_end"
        | "service_due"
        | "pcn_report"
        | "driver_document_expiry"
        | "vehicle_compliance_expiry"
        | "vehicle_document_expiry"
        | "driver_compliance_expiry"
      payment_source:
        | "manual"
        | "bank_transfer"
        | "gocardless"
        | "stripe"
        | "cash"
      payment_status: "pending" | "confirmed" | "failed" | "refunded"
      rent_status: "due" | "paid" | "part_paid" | "overdue" | "waived"
      severity: "info" | "warning" | "critical"
      signing_status:
        | "partner_review"
        | "driver_sign"
        | "signed"
        | "declined"
        | "cancelled"
      tenant_plan: "trial" | "starter" | "growth" | "scale"
      tenant_status: "active" | "suspended" | "cancelled"
      user_role: "ops" | "driver" | "investor" | "owner"
      vehicle_status: "available" | "on_hire" | "off_road" | "sold"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      agreement_status: [
        "draft",
        "pending_signature",
        "active",
        "ended",
        "defaulted",
        "transferred",
      ],
      agreement_type: ["standard", "rtb"],
      alert_kind: [
        "speeding",
        "night_movement",
        "zone_exit",
        "device_offline",
        "immobilised",
        "released",
      ],
      booking_source: ["dispatch", "app", "job_sheet"],
      booking_status: [
        "requested",
        "assigned",
        "en_route",
        "in_progress",
        "completed",
        "cancelled",
        "no_show",
      ],
      cert_status: ["pending", "verified", "rejected", "expired"],
      charge_status: [
        "received",
        "driver_notified",
        "driver_liable",
        "disputed",
        "paid_by_driver",
        "paid_by_company",
        "cancelled",
      ],
      charge_type: [
        "pcn",
        "congestion",
        "ulez",
        "dartford",
        "toll",
        "other",
        "airport",
      ],
      deposit_event: ["held", "deducted", "refunded", "forfeited"],
      driver_status: ["lead", "vetting", "active", "suspended", "terminated"],
      fuel_payment_method: [
        "cash",
        "card",
        "fuel_card",
        "company_account",
        "other",
      ],
      fuel_type: ["phev", "ev", "petrol", "diesel", "hybrid"],
      gfv_status: ["unconfirmed", "confirmed", "settled", "na"],
      invoice_status: ["open", "paid", "part_paid", "void", "overdue"],
      maintenance_payer: ["company", "driver"],
      membership_status: ["active", "invited", "disabled"],
      obligation_status: [
        "open",
        "due_soon",
        "overdue",
        "resolved",
        "dismissed",
      ],
      obligation_type: [
        "insurance_expiry",
        "pco_licence_expiry",
        "dvla_check",
        "mot",
        "ved_renewal",
        "gfv_settlement",
        "agreement_end",
        "service_due",
        "pcn_report",
        "driver_document_expiry",
        "vehicle_compliance_expiry",
        "vehicle_document_expiry",
        "driver_compliance_expiry",
      ],
      payment_source: [
        "manual",
        "bank_transfer",
        "gocardless",
        "stripe",
        "cash",
      ],
      payment_status: ["pending", "confirmed", "failed", "refunded"],
      rent_status: ["due", "paid", "part_paid", "overdue", "waived"],
      severity: ["info", "warning", "critical"],
      signing_status: [
        "partner_review",
        "driver_sign",
        "signed",
        "declined",
        "cancelled",
      ],
      tenant_plan: ["trial", "starter", "growth", "scale"],
      tenant_status: ["active", "suspended", "cancelled"],
      user_role: ["ops", "driver", "investor", "owner"],
      vehicle_status: ["available", "on_hire", "off_road", "sold"],
    },
  },
} as const


// Convenience alias for the profile role enum, imported across the app
// (auth gating, nav, shell, middleware). Derived from the generated Database
// type so it stays in sync with the schema.
export type UserRole = Database["public"]["Enums"]["user_role"];
