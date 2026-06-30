import type { RmaTicket } from "../types";

/**
 * Section / group definition for the case detail sheet.
 *
 * The shape is decoupled from the API payload so we can mock data
 * before the backend endpoint exists, and so we can mix Case-fields
 * with Tech_Asset__c-fields in arbitrary visual groups.
 */

export type FieldType = "text" | "textarea" | "picklist" | "multipicklist"
  | "bool" | "date" | "datetime" | "currency" | "number" | "lookup";

export interface SheetField {
  /** Salesforce field name; used as the API write key once we wire edits. */
  apiName: string;
  /** UI label key (i18n) or literal label. */
  label: string;
  /** Current value. */
  value: string | number | boolean | null;
  type: FieldType;
  /** Editable through the Salesforce REST API in the user's profile. */
  editable: boolean;
  /** For picklists. */
  options?: string[];
  /** Object the field lives on, used by the writer to pick the right endpoint. */
  sobject: "Case" | "Tech_Asset__c";
  /** Wide cell (full-width) or narrow (half). */
  wide?: boolean;
  /** Render with monospace, e.g. for hostnames / MACs / IDs. */
  mono?: boolean;
  /** Lookup display name (only when ``type === "lookup"``). */
  displayValue?: string | null;
  /** Deep link to the related record in GUS Lightning. */
  linkUrl?: string | null;
  /** SObjects this lookup can reference. */
  referenceTo?: string[];
  /** Optional partition / cascade hints for SM_General_Picklist__c
   *  lookups (Case Category / Subcategory / Resolution). */
  lookupListType?: string | null;
  lookupRecordTypeFilter?: string | null;
  lookupParentField?: string | null;
}

export interface SheetGroup {
  title: string;
  fields: SheetField[];
}

export interface SheetSection {
  /** "case" | "asset" — used for icons and the section header. */
  kind: "case" | "asset";
  title: string;
  subtitle?: string;
  groups: SheetGroup[];
}

/* --- Mock data, modelled on Case 87498113 / Tech_Asset__c a2OB0…ls -------- */

export function buildMockSections(ticket: RmaTicket): SheetSection[] {
  // A ticket opened from a search / chat lookup is a stub — only
  // id / name / status are set; the rest arrives with the detail fetch
  // that supersedes these mock sections moments later. Default the
  // fields this fallback reads so the first render can't crash on a
  // stub (undefined.split / undefined value). See CLAUDE.md white-screen.
  const assetName = ticket.assetName ?? "";
  const assetParts = assetName.split("/");
  return [
    {
      kind: "case",
      title: "Case",
      subtitle: ticket.name,
      groups: [
        {
          title: "Identification",
          fields: [
            { apiName: "CaseNumber", label: "Case number", value: ticket.name,
              type: "text", editable: false, sobject: "Case", mono: true },
            { apiName: "Subject", label: "Subject", value: ticket.componentType,
              type: "text", editable: true, sobject: "Case", wide: true },
            { apiName: "Status", label: "Status", value: ticket.status,
              type: "picklist", editable: true, sobject: "Case",
              options: [
                "New", "In Progress", "Working",
                "Pending Drain", "Drained", "Remediating",
                "Waiting for External Party", "Escalated",
                "Return to Service", "HW Repaired",
                "Resolved", "Closed",
              ] },
            { apiName: "Priority", label: "Priority", value: ticket.priority,
              type: "picklist", editable: true, sobject: "Case",
              options: ["Sev0", "Sev1", "Sev2", "Sev3", "Sev4", "Sev5"] },
            { apiName: "Description", label: "Description",
              value: ticket.description, type: "textarea", editable: true,
              sobject: "Case", wide: true },
          ],
        },
        {
          title: "Datacenter & routing",
          fields: [
            { apiName: "SM_Data_Center_Facility__c", label: "Facility",
              value: ticket.location, type: "multipicklist", editable: true,
              sobject: "Case",
              options: ["FRA1", "FRA2", "FRA3", "CDG1", "CDG2", "CDG3"] },
            { apiName: "RMA_Email__c", label: "RMA email queue",
              value: "dceng-fra3@salesforce.com",
              type: "picklist", editable: true, sobject: "Case",
              options: [
                "dceng-fra3@salesforce.com",
                "mc-linuxadmins@salesforce.com",
                "mc-osadmins@salesforce.com",
                "sfdcrma@salesforce.com",
              ] },
            { apiName: "Scrum_Team_Name__c", label: "Scrum team",
              value: ticket.assignee || "DCENG-RMA",
              type: "lookup", editable: true, sobject: "Case" },
          ],
        },
        {
          title: "Classification",
          fields: [
            { apiName: "SM_Category__c", label: "Category",
              value: "Server Device", type: "picklist", editable: true,
              sobject: "Case",
              options: ["Server Device", "Network Device", "Storage Device",
                "Power", "Cabling", "Other"] },
            { apiName: "SM_Sub_Category__c", label: "Sub-category",
              value: "Other", type: "picklist", editable: true,
              sobject: "Case",
              options: ["BMC", "Memory", "CPU", "Disk", "PSU", "Mainboard",
                "Network", "Other"] },
            { apiName: "True_Risk_Level__c", label: "Risk level",
              value: "Low", type: "picklist", editable: true,
              sobject: "Case", options: ["Low", "High"] },
          ],
        },
        {
          title: "Workflow",
          fields: [
            { apiName: "SM_Last_Comment__c", label: "Last comment",
              value: "Issue: BMC is not authenticatable",
              type: "text", editable: true, sobject: "Case", wide: true },
            { apiName: "SM_Vendor_Tech_Dispatched__c", label: "Vendor tech dispatched",
              value: false, type: "bool", editable: true, sobject: "Case" },
            { apiName: "SM_After_Hours_Required__c", label: "After-hours required",
              value: false, type: "bool", editable: true, sobject: "Case" },
            { apiName: "SM_Failure_Analysis_Required__c", label: "FA required",
              value: false, type: "bool", editable: true, sobject: "Case" },
            { apiName: "SM_RCA_Required__c", label: "RCA required",
              value: false, type: "bool", editable: true, sobject: "Case" },
            { apiName: "Parts_Locker_Eligible__c", label: "Parts locker eligible",
              value: true, type: "bool", editable: true, sobject: "Case" },
            { apiName: "SM_Escalated_issue__c", label: "Escalated issue",
              value: false, type: "bool", editable: true, sobject: "Case" },
            { apiName: "SM_Requires_Security_Approval__c",
              label: "Needs security approval",
              value: false, type: "bool", editable: true, sobject: "Case" },
          ],
        },
        {
          title: "Times",
          fields: [
            { apiName: "SM_Date_Time_Opened__c", label: "Opened",
              value: ticket.createdDate, type: "datetime", editable: true,
              sobject: "Case" },
            { apiName: "SM_Date_Time_Incident_Started__c", label: "Incident started",
              value: ticket.createdDate, type: "datetime", editable: true,
              sobject: "Case" },
            { apiName: "SM_Last_Response_Date__c", label: "Last response",
              value: "2026-01-30", type: "date", editable: true, sobject: "Case" },
          ],
        },
      ],
    },
    {
      kind: "asset",
      title: "Asset",
      subtitle: assetName,
      groups: [
        {
          title: "Identification",
          fields: [
            { apiName: "Name", label: "Asset name",
              value: assetName,
              type: "text", editable: true, sobject: "Tech_Asset__c", wide: true, mono: true },
            { apiName: "Asset_Number__c", label: "Asset number",
              value: assetParts[0]?.trim() ?? "",
              type: "text", editable: true, sobject: "Tech_Asset__c", mono: true },
            { apiName: "Tech_Ops_Serial_Number__c", label: "Serial number",
              value: assetParts[1]?.trim() ?? "",
              type: "text", editable: true, sobject: "Tech_Asset__c", mono: true },
            { apiName: "Device_Name__c", label: "Hostname",
              value: assetParts[2]?.trim() ?? "",
              type: "text", editable: true, sobject: "Tech_Asset__c", mono: true },
            { apiName: "Estates_Role__c", label: "Estates role",
              value: "baseline",
              type: "text", editable: true, sobject: "Tech_Asset__c" },
          ],
        },
        {
          title: "Hardware",
          fields: [
            { apiName: "Asset_Type_Manufacturer__c", label: "Manufacturer",
              value: "HEWLETT PACKARD",
              type: "text", editable: false, sobject: "Tech_Asset__c" },
            { apiName: "Asset_Type_Make__c", label: "Make",
              value: "PROLIANT",
              type: "text", editable: false, sobject: "Tech_Asset__c" },
            { apiName: "Asset_Type_Model__c", label: "Model",
              value: "DL360",
              type: "text", editable: false, sobject: "Tech_Asset__c" },
            { apiName: "Asset_Type_Configuration__c", label: "Configuration",
              value: "SSKUE-25G",
              type: "text", editable: false, sobject: "Tech_Asset__c" },
            { apiName: "Asset_Type_Configuration_Description__c",
              label: "Configuration desc.",
              value: "25Gb Network Card", type: "text", editable: false,
              sobject: "Tech_Asset__c", wide: true },
            { apiName: "Server_Architecture_Class__c", label: "Architecture class",
              value: "SSKUE",
              type: "text", editable: false, sobject: "Tech_Asset__c" },
          ],
        },
        {
          title: "Network",
          fields: [
            { apiName: "MAC_Address__c", label: "MAC address",
              value: "9440C97628A0",
              type: "text", editable: true, sobject: "Tech_Asset__c", mono: true },
            { apiName: "DRAC_MAC_Address__c", label: "DRAC MAC",
              value: "9440C93591DE",
              type: "text", editable: true, sobject: "Tech_Asset__c", mono: true },
            { apiName: "Discovered_Host_Name__c", label: "Discovered hostname",
              value: assetParts[2]?.trim() ?? "",
              type: "text", editable: true, sobject: "Tech_Asset__c", mono: true },
          ],
        },
        {
          title: "Rack position",
          fields: [
            { apiName: "Location_Facility__c", label: "Facility",
              value: ticket.location || "FRA3",
              type: "text", editable: false, sobject: "Tech_Asset__c" },
            { apiName: "Location_Colo__c", label: "Colo",
              value: "14.1",
              type: "text", editable: false, sobject: "Tech_Asset__c" },
            { apiName: "Location_Cage_Room__c", label: "Cage / room",
              value: "124",
              type: "text", editable: false, sobject: "Tech_Asset__c" },
            { apiName: "Location_Rack_Number__c", label: "Rack",
              value: "C15",
              type: "text", editable: false, sobject: "Tech_Asset__c" },
            { apiName: "RackUPos_Number__c", label: "U position",
              value: "18",
              type: "text", editable: false, sobject: "Tech_Asset__c" },
            { apiName: "Device_U_Height__c", label: "U height",
              value: "1",
              type: "text", editable: false, sobject: "Tech_Asset__c" },
            { apiName: "Location_City__c", label: "City",
              value: "Frankfurt",
              type: "text", editable: false, sobject: "Tech_Asset__c" },
            { apiName: "Region__c", label: "Region",
              value: "EMEA",
              type: "text", editable: false, sobject: "Tech_Asset__c" },
          ],
        },
        {
          title: "Lifecycle",
          fields: [
            { apiName: "SVC_State__c", label: "Service state",
              value: "ACTIVE",
              type: "text", editable: true, sobject: "Tech_Asset__c" },
            { apiName: "Provisioning_Status__c", label: "Provisioning",
              value: "Completed",
              type: "text", editable: false, sobject: "Tech_Asset__c" },
            { apiName: "iDB_Host_Operational_Status__c", label: "iDB status",
              value: "Deleted From iDB",
              type: "text", editable: false, sobject: "Tech_Asset__c" },
            { apiName: "iDB_or_Parsed_Role__c", label: "iDB role",
              value: "Racktastic Unassigned",
              type: "text", editable: false, sobject: "Tech_Asset__c" },
            { apiName: "End_Of_Service_Life_Date__c", label: "End of service life",
              value: "2027-04-14",
              type: "date", editable: false, sobject: "Tech_Asset__c" },
            { apiName: "Support_End_Date__c", label: "Support ends",
              value: "2026-01-31",
              type: "date", editable: false, sobject: "Tech_Asset__c" },
          ],
        },
        {
          title: "Discovery & inspection",
          fields: [
            { apiName: "Recently_Discovered__c", label: "Recently discovered",
              value: true, type: "bool", editable: true, sobject: "Tech_Asset__c" },
            { apiName: "Hard_drive_wiped__c", label: "Drive wiped",
              value: false, type: "bool", editable: true, sobject: "Tech_Asset__c" },
            { apiName: "Mgmt_Console_Reset__c", label: "Mgmt console reset",
              value: "No", type: "picklist", editable: true,
              sobject: "Tech_Asset__c", options: ["No", "Yes"] },
            { apiName: "Physically_Inspected__c", label: "Physically inspected",
              value: "No", type: "picklist", editable: true,
              sobject: "Tech_Asset__c", options: ["No", "Yes"] },
            { apiName: "Modified_Upgraded__c", label: "Modified / upgraded",
              value: false, type: "bool", editable: true, sobject: "Tech_Asset__c" },
          ],
        },
      ],
    },
  ];
}
