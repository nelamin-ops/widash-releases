"""Build a structured detail view for a single Case + its Tech_Asset.

Defines which Salesforce fields land in which sheet section/group, then
combines the live record values with the describe metadata so the UI gets
a single typed payload. The describe call is cached for the life of the
process; only the per-record reads happen on each request.
"""
from __future__ import annotations

import logging
from threading import Lock
from typing import Any, Optional

from simple_salesforce import Salesforce

logger = logging.getLogger("widash.case_detail")

from .models import (
    CaseDetailField, CaseDetailGroup, CaseDetailResponse, CaseDetailSection,
)


# ---- describe cache --------------------------------------------------------

_describe_cache: dict[str, dict[str, dict[str, Any]]] = {}
_describe_lock = Lock()


def _describe_fields_by_name(sf: Salesforce, sobject: str) -> dict[str, dict[str, Any]]:
    """Return ``{fieldName: describeFieldDict}`` for the given object."""
    with _describe_lock:
        cached = _describe_cache.get(sobject)
        if cached is not None:
            return cached
    obj = getattr(sf, sobject)
    data = obj.describe()
    by_name = {f["name"]: f for f in data.get("fields", [])}
    with _describe_lock:
        _describe_cache[sobject] = by_name
    return by_name


def _normalise_type(sf_type: str) -> str:
    """Map Salesforce field types to the smaller UI vocabulary."""
    if sf_type in ("string", "phone", "email", "url", "id", "encryptedstring"):
        return "text"
    if sf_type == "textarea":
        return "textarea"
    if sf_type == "boolean":
        return "bool"
    if sf_type == "double":
        return "number"
    if sf_type == "int":
        return "number"
    if sf_type == "currency":
        return "currency"
    if sf_type in ("date",):
        return "date"
    if sf_type in ("datetime",):
        return "datetime"
    if sf_type == "picklist":
        return "picklist"
    if sf_type == "multipicklist":
        return "multipicklist"
    if sf_type == "reference":
        return "lookup"
    return "text"


def _picklist_options(field_meta: dict[str, Any]) -> list[str]:
    return [
        pv["value"] for pv in field_meta.get("picklistValues", [])
        if pv.get("active")
    ]


# ---- record-type-aware picklist values -----------------------------------

# Cache picklist values per (sobject, recordTypeId, fieldApiName) since the
# UI-API call costs a round trip and these only change with metadata
# deployments. Salesforce returns the layout-trimmed values which is what
# the user actually sees in the GUS UI — instead of all 80+ Status values.
_rt_picklist_cache: dict[tuple[str, str, str], list[str]] = {}
_rt_picklist_lock = Lock()


def _rt_picklist_values(
    sf: Salesforce, sobject: str, record_type_id: str, field_api_name: str,
) -> Optional[list[str]]:
    if not record_type_id:
        return None
    key = (sobject, record_type_id, field_api_name)
    with _rt_picklist_lock:
        cached = _rt_picklist_cache.get(key)
        if cached is not None:
            return cached
    path = (
        f"ui-api/object-info/{sobject}/picklist-values/"
        f"{record_type_id}/{field_api_name}"
    )
    try:
        data = sf.restful(path, method="GET")
    except Exception as e:  # noqa: BLE001
        logger.debug("ui-api picklist fetch failed for %s: %s", path, e)
        return None
    values = [v.get("value") for v in (data.get("values") or []) if v.get("value")]
    with _rt_picklist_lock:
        _rt_picklist_cache[key] = values
    return values


def _build_field(
    *,
    api_name: str,
    label: str,
    record: dict[str, Any],
    field_meta: dict[str, Any],
    sf: Salesforce,
    sobject: str,
    record_type_id: Optional[str],
    instance_url: Optional[str] = None,
) -> CaseDetailField:
    sf_type = _normalise_type(field_meta.get("type") or "string")
    options: list[str] = []
    if sf_type in ("picklist", "multipicklist"):
        # Prefer the record-type-trimmed list if we can get it, since
        # that's what the GUS layout actually offers. Fall back to the
        # full describe list when the UI-API call fails.
        rt_options = (
            _rt_picklist_values(sf, sobject, record_type_id, api_name)
            if record_type_id else None
        )
        options = rt_options if rt_options else _picklist_options(field_meta)

    display_value: Optional[str] = None
    link_url: Optional[str] = None
    reference_to: list[str] = []
    lookup_list_type: Optional[str] = None
    lookup_record_type_filter: Optional[str] = None
    lookup_parent_field: Optional[str] = None
    if sf_type == "lookup":
        reference_to = list(field_meta.get("referenceTo") or [])
        rel_name = field_meta.get("relationshipName")
        related = record.get(rel_name) if rel_name else None
        if isinstance(related, dict):
            # Owner -> Group / User: pick whichever name field is
            # populated. Most lookups expose Name, Users expose Username
            # and Name.
            display_value = (
                related.get("Name")
                or related.get("Username")
                or None
            )
        rec_id = record.get(api_name)
        if rec_id and instance_url:
            link_url = f"{instance_url.rstrip('/')}/lightning/r/{rec_id}/view"
        # Three Case fields are lookups onto a shared "general picklist"
        # table. Tag them so the frontend dropdown filters down to just
        # the relevant slice (and the Subcategory cascades off Category).
        if reference_to == ["SM_General_Picklist__c"]:
            if api_name == "SM_Case_Category__c":
                lookup_list_type = "Category"
                lookup_record_type_filter = "RMA"
            elif api_name == "SM_Case_Subcategory__c":
                lookup_list_type = "Subcategory"
                lookup_parent_field = "SM_Case_Category__c"
            elif api_name == "SM_Case_Resolution__c":
                lookup_list_type = "Resolution"
                lookup_record_type_filter = "RMA"

    return CaseDetailField(
        apiName=api_name,
        label=label,
        value=record.get(api_name),
        type=sf_type,
        editable=bool(field_meta.get("updateable")),
        options=options,
        displayValue=display_value,
        linkUrl=link_url,
        referenceTo=reference_to,
        lookupListType=lookup_list_type,
        lookupRecordTypeFilter=lookup_record_type_filter,
        lookupParentField=lookup_parent_field,
    )


# ---- field layout (mirrors frontend/src/components/sheetSections.ts) -------

# Each group is a list of (apiName, label) pairs. The describe result
# fills in type / editable / options. ``label`` is the UI-friendly
# fallback when the SF field label isn't ideal.

CASE_GROUPS: list[tuple[str, list[tuple[str, str]]]] = [
    ("Identification", [
        ("CaseNumber", "Case number"),
        ("Subject", "Subject"),
        ("Status", "Status"),
        ("Priority", "Priority"),
        ("Description", "Description"),
    ]),
    # "Responsible Parties" group — mirrors the equivalent block in GUS.
    # Everything here is a person/group/team lookup; OwnerId stays
    # read-only on purpose (reassignment goes through Team).
    ("Responsible parties", [
        ("OwnerId", "Case owner"),
        ("Scrum_Team__c", "Team"),
        ("SM_Business_Name__c", "Service owner"),
        ("SM_Incident_Communications_Owner__c", "Incident communications owner (ICO)"),
        ("SM_Incident_Documentation_Owner__c", "Incident documentation owner (IDO)"),
        ("CreatedById", "Created by"),
        ("LastModifiedById", "Last modified by"),
    ]),
    ("Datacenter & routing", [
        ("SM_Data_Center_Facility__c", "Facility"),
        ("RMA_Email__c", "RMA email queue"),
        ("Scrum_Team_Name__c", "Scrum team"),
    ]),
    # Case Category / Subcategory / Resolution are surfaced as pills in
    # the sheet header instead of inline fields — keep them in the
    # payload (under their own slot) so the picker can render and write
    # them, but don't repeat them in the visible Classification group.
    ("__hidden_header_fields", [
        ("SM_Case_Category__c", "Case category"),
        ("SM_Case_Subcategory__c", "Case subcategory"),
        ("SM_Case_Resolution__c", "Case resolution"),
    ]),
    ("Classification", [
        ("SM_Category__c", "Category"),
        ("SM_Sub_Category__c", "Sub-category"),
        ("True_Risk_Level__c", "Risk level"),
    ]),
    ("Workflow", [
        ("SM_Last_Comment__c", "Last comment"),
        ("SM_Vendor_Tech_Dispatched__c", "Vendor tech dispatched"),
        ("SM_After_Hours_Required__c", "After-hours required"),
        ("SM_Failure_Analysis_Required__c", "FA required"),
        ("SM_RCA_Required__c", "RCA required"),
        ("Parts_Locker_Eligible__c", "Parts locker eligible"),
        ("SM_Escalated_issue__c", "Escalated issue"),
        ("SM_Requires_Security_Approval__c", "Needs security approval"),
    ]),
    ("Times", [
        ("SM_Date_Time_Opened__c", "Opened"),
        ("SM_Date_Time_Incident_Started__c", "Incident started"),
        ("SM_Last_Response_Date__c", "Last response"),
    ]),
]

ASSET_GROUPS: list[tuple[str, list[tuple[str, str]]]] = [
    ("Identification", [
        ("Name", "Asset name"),
        ("Asset_Number__c", "Asset number"),
        ("Tech_Ops_Serial_Number__c", "Serial number"),
        ("Device_Name__c", "Hostname"),
        ("Estates_Role__c", "Estates role"),
    ]),
    ("Hardware", [
        ("Asset_Type_Manufacturer__c", "Manufacturer"),
        ("Asset_Type_Make__c", "Make"),
        ("Asset_Type_Model__c", "Model"),
        ("Asset_Type_Configuration__c", "Configuration"),
        ("Asset_Type_Configuration_Description__c", "Configuration desc."),
        ("Server_Architecture_Class__c", "Architecture class"),
    ]),
    ("Network", [
        ("MAC_Address__c", "MAC address"),
        ("DRAC_MAC_Address__c", "DRAC MAC"),
        ("Discovered_Host_Name__c", "Discovered hostname"),
    ]),
    ("Rack position", [
        ("Location_Facility__c", "Facility"),
        ("Location_Colo__c", "Colo"),
        ("Location_Cage_Room__c", "Cage / room"),
        ("Location_Rack_Number__c", "Rack"),
        ("RackUPos_Number__c", "U position"),
        ("Device_U_Height__c", "U height"),
        ("Location_City__c", "City"),
        ("Region__c", "Region"),
    ]),
    ("Lifecycle", [
        ("SVC_State__c", "Service state"),
        ("Provisioning_Status__c", "Provisioning"),
        ("iDB_Host_Operational_Status__c", "iDB status"),
        ("iDB_or_Parsed_Role__c", "iDB role"),
        ("End_Of_Service_Life_Date__c", "End of service life"),
        ("Support_End_Date__c", "Support ends"),
    ]),
    ("Discovery & inspection", [
        ("Recently_Discovered__c", "Recently discovered"),
        ("Hard_drive_wiped__c", "Drive wiped"),
        ("Mgmt_Console_Reset__c", "Mgmt console reset"),
        ("Physically_Inspected__c", "Physically inspected"),
        ("Modified_Upgraded__c", "Modified / upgraded"),
    ]),
]


def _all_field_names(groups: list[tuple[str, list[tuple[str, str]]]]) -> list[str]:
    names: list[str] = []
    for _, fields in groups:
        for api, _label in fields:
            names.append(api)
    return names


def _build_section(
    *,
    kind: str,
    title: str,
    subtitle: str,
    record: dict[str, Any],
    fields_meta: dict[str, dict[str, Any]],
    layout: list[tuple[str, list[tuple[str, str]]]],
    sf: Salesforce,
    sobject: str,
    record_type_id: Optional[str],
    instance_url: Optional[str] = None,
) -> CaseDetailSection:
    groups: list[CaseDetailGroup] = []
    for group_title, fields in layout:
        out_fields: list[CaseDetailField] = []
        for api_name, label in fields:
            meta = fields_meta.get(api_name)
            if meta is None:
                continue
            out_fields.append(_build_field(
                api_name=api_name,
                label=label,
                record=record,
                field_meta=meta,
                sf=sf,
                sobject=sobject,
                record_type_id=record_type_id,
                instance_url=instance_url,
            ))
        if out_fields:
            groups.append(CaseDetailGroup(title=group_title, fields=out_fields))
    return CaseDetailSection(
        kind=kind, title=title, subtitle=subtitle, groups=groups,
    )


class WriteValidationError(ValueError):
    """The caller-provided changes can't be applied as-is."""


def _coerce_value(field_meta: dict[str, Any], value: Any) -> Any:
    """Convert an incoming JSON value into the shape Salesforce expects.

    The frontend posts strings for most fields; SF wants typed values for
    numbers, booleans, and dates. Empty strings get translated to None so
    a user clearing a field actually clears it rather than writing "".
    """
    if value == "":
        return None
    sf_type = field_meta.get("type")
    if value is None:
        return None
    if sf_type == "boolean":
        return bool(value)
    if sf_type in ("double", "currency"):
        try: return float(value)
        except (TypeError, ValueError): raise WriteValidationError(
            f"{field_meta['name']}: not a number ({value!r})",
        )
    if sf_type == "int":
        try: return int(value)
        except (TypeError, ValueError): raise WriteValidationError(
            f"{field_meta['name']}: not an int ({value!r})",
        )
    return value


def write_record_fields(
    sf: Salesforce,
    sobject: str,
    record_id: str,
    changes: list[dict[str, Any]],
) -> None:
    """Validate + apply ``changes`` (list of {apiName, value}) to a record.

    All-or-nothing: any unknown / non-updateable field aborts the write
    before the SF call. Type-coercion happens here too. Raises
    WriteValidationError for caller-faulty input; lets simple_salesforce
    errors propagate so the FastAPI handlers turn them into 4xx/5xx.
    """
    if not changes:
        return
    fields_meta = _describe_fields_by_name(sf, sobject)
    payload: dict[str, Any] = {}
    for c in changes:
        api_name = c.get("apiName")
        if not api_name:
            raise WriteValidationError("change entry missing apiName")
        meta = fields_meta.get(api_name)
        if meta is None:
            raise WriteValidationError(
                f"unknown field {api_name} on {sobject}",
            )
        if not meta.get("updateable"):
            raise WriteValidationError(
                f"field {api_name} is not updateable on {sobject}",
            )
        payload[api_name] = _coerce_value(meta, c.get("value"))
    if not payload:
        return
    sf_object = getattr(sf, sobject)
    sf_object.update(record_id, payload)


def _expand_select(
    sobject: str, field_names: list[str], fields_meta: dict[str, dict[str, Any]],
) -> list[str]:
    """For each lookup field add its ``relName.Name``/``Username`` so the
    UI gets the friendly name without a second round-trip."""
    out = list(field_names)
    for name in field_names:
        meta = fields_meta.get(name)
        if not meta or meta.get("type") != "reference":
            continue
        rel = meta.get("relationshipName")
        if not rel:
            continue
        # Owner is special — refers to Group OR User, both have Name.
        # User additionally has Username. Asking for Username on a Group
        # row would fail, so we add it only for User-only refs.
        out.append(f"{rel}.Name")
        if meta.get("referenceTo") == ["User"]:
            out.append(f"{rel}.Username")
    return out


def get_case_detail(
    sf: Salesforce, case_id: str, asset_id_hint: Optional[str] = None,
) -> Optional[CaseDetailResponse]:
    """Return the structured detail view for a Case, or None if not found.

    ``asset_id_hint`` is the Tech_Asset__c id we already know from the
    active-RMA report (Case.AssetId is rarely populated; the report's
    FK_Tech_Asset__c column is the real link). When provided, we skip
    the AssetId lookup and go straight to that record.
    """
    case_meta = _describe_fields_by_name(sf, "Case")
    case_fields = _expand_select(
        "Case",
        _all_field_names(CASE_GROUPS) + ["AssetId", "RecordTypeId"],
        case_meta,
    )
    case_select = ",".join(case_fields)
    case_q = f"SELECT {case_select} FROM Case WHERE Id = '{case_id}' LIMIT 1"
    rows = sf.query(case_q).get("records", [])
    if not rows:
        return None
    case_record = rows[0]
    case_record_type_id = case_record.get("RecordTypeId") or None

    instance_url = getattr(sf, "base_url", None) or getattr(sf, "sf_instance", None)
    # simple_salesforce exposes ``sf_instance`` (host without scheme) and
    # ``base_url`` (host + /services/...). Build a clean Lightning origin.
    sf_instance = getattr(sf, "sf_instance", "") or ""
    if sf_instance:
        instance_url = f"https://{sf_instance.rstrip('/')}"

    sections: list[CaseDetailSection] = [
        _build_section(
            kind="case",
            title="Case",
            subtitle=str(case_record.get("CaseNumber") or ""),
            record=case_record,
            fields_meta=case_meta,
            layout=CASE_GROUPS,
            sf=sf,
            sobject="Case",
            record_type_id=case_record_type_id,
            instance_url=instance_url,
        ),
    ]

    # Resolve the asset Id: caller-provided hint wins (comes from the
    # active-report's FK_Tech_Asset__c column which is the real link),
    # otherwise fall back to the Case.AssetId standard relationship.
    asset_id = asset_id_hint or case_record.get("AssetId")
    if asset_id:
        asset_meta = _describe_fields_by_name(sf, "Tech_Asset__c")
        asset_fields = _expand_select(
            "Tech_Asset__c",
            _all_field_names(ASSET_GROUPS) + ["RecordTypeId"],
            asset_meta,
        )
        asset_select = ",".join(asset_fields)
        asset_q = (
            f"SELECT {asset_select} FROM Tech_Asset__c "
            f"WHERE Id = '{asset_id}' LIMIT 1"
        )
        asset_rows = sf.query(asset_q).get("records", [])
        if asset_rows:
            asset_record = asset_rows[0]
            sections.append(_build_section(
                kind="asset",
                title="Asset",
                subtitle=str(asset_record.get("Name") or ""),
                record=asset_record,
                fields_meta=asset_meta,
                layout=ASSET_GROUPS,
                sf=sf,
                sobject="Tech_Asset__c",
                record_type_id=asset_record.get("RecordTypeId") or None,
                instance_url=instance_url,
            ))

    return CaseDetailResponse(
        caseId=case_id,
        caseNumber=str(case_record.get("CaseNumber") or ""),
        assetId=asset_id or None,
        sections=sections,
    )
