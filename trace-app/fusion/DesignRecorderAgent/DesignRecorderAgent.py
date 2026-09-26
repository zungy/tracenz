import adsk.core
import adsk.fusion
import json
import os
import re
import traceback
import base64
import urllib.request
import urllib.error
import importlib.util
import uuid
from datetime import datetime, timezone

# -----------------------------------------------------------------------------
# Design Recorder Agent v0.6
# Fusion add-in: captures structured CAD state on a user-triggered checkpoint,
# diffs against the previous checkpoint, saves a clean viewport image, and then
# saves the Fusion document.
# -----------------------------------------------------------------------------

APP = None
UI = None
HANDLERS = []
CUSTOM_EVENT = None
LAST_SNAPSHOT = None
LAST_DOCUMENT_KEY = None

COMMAND_ID = 'DesignRecorderAgent_RecordCheckpoint'
COMMAND_NAME = 'Record Design Change'
COMMAND_TOOLTIP = 'Capture CAD changes, viewport image, and save the Fusion document.'
CUSTOM_EVENT_ID = 'DesignRecorderAgent_RecordCheckpointEvent_v1'
PANEL_ID = 'SolidScriptsAddinsPanel'

OUTPUT_ROOT = os.path.join(
    os.path.expanduser('~'),
    'Documents',
    'DesignRecorder',
    'Fusion'
)

# Delivery discovers the local Trace receiver automatically. The legacy URL
# is ignored; uploadEnabled remains a supported user setting.
ADDIN_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(ADDIN_DIR, 'DesignRecorderAgent.config.json')
DEFAULT_UPLOAD_URL = ''
TRANSPORT = None
SHORTCUT_LISTENER = None
UPLOAD_TIMEOUT_SECONDS = 8


def _now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds')


def _timestamp_for_file():
    return datetime.now().strftime('%Y-%m-%d_%H-%M-%S_%f')


def _safe_filename(value):
    value = value or 'Untitled'
    value = re.sub(r'[<>:"/\\|?*]+', '_', value)
    value = value.strip(' .')
    return value[:120] or 'Untitled'


def _short_type(obj):
    try:
        object_type = obj.objectType or ''
        return object_type.split('::')[-1]
    except:
        return ''


def _safe_get(obj, attr, default=None):
    try:
        value = getattr(obj, attr)
        return value
    except:
        return default


def _feature_operation_name(feature):
    """Return a stable human-readable Fusion boolean operation when exposed."""
    try:
        operation = feature.operation
        mapping = {
            adsk.fusion.FeatureOperations.JoinFeatureOperation: 'join',
            adsk.fusion.FeatureOperations.CutFeatureOperation: 'cut',
            adsk.fusion.FeatureOperations.IntersectFeatureOperation: 'intersect',
            adsk.fusion.FeatureOperations.NewBodyFeatureOperation: 'new_body',
            adsk.fusion.FeatureOperations.NewComponentFeatureOperation: 'new_component',
        }
        return mapping.get(operation, str(operation))
    except:
        return ''


def _feature_kind(feature_type):
    mapping = {
        'ExtrudeFeature': 'extrusion',
        'HoleFeature': 'hole',
        'FilletFeature': 'fillet',
        'ChamferFeature': 'chamfer',
        'BoxFeature': 'box',
        'RevolveFeature': 'revolve',
        'SweepFeature': 'sweep',
        'LoftFeature': 'loft',
        'ShellFeature': 'shell',
        'PatternFeature': 'pattern',
    }
    if feature_type in mapping:
        return mapping[feature_type]
    if feature_type.endswith('Feature'):
        return feature_type[:-7].lower()
    return (feature_type or 'feature').lower()


def _timeline_index(obj):
    try:
        timeline_obj = obj.timelineObject
        if timeline_obj:
            return timeline_obj.index
    except:
        pass
    return None


def _document_key(doc):
    try:
        data_file = doc.dataFile
        if data_file:
            return data_file.id
    except:
        pass
    try:
        return doc.name
    except:
        return 'UnknownDocument'


def _json_dump(data, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(data, handle, indent=2, ensure_ascii=False)


def _load_config():
    config = {
        'uploadEnabled': True,
        'uploadUrl': DEFAULT_UPLOAD_URL,
    }

    try:
        if os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, 'r', encoding='utf-8') as handle:
                loaded = json.load(handle)
                if isinstance(loaded, dict):
                    config.update(loaded)
    except:
        if APP:
            APP.log('Design Recorder config load failed:\n' + traceback.format_exc())

    return config


def _upload_event(event, image_path, event_path):
    if not _load_config().get('uploadEnabled', True):
        return {'ok': False, 'queued': False, 'message': 'Delivery disabled; checkpoint saved locally.'}
    try:
        return TRANSPORT.enqueue(event, image_path, event_path)
    except Exception:
        return {'ok': False, 'queued': False, 'message': 'Could not queue delivery; original checkpoint kept locally.'}


def _creator_info(parameter):
    creator = None
    try:
        model_param = adsk.fusion.ModelParameter.cast(parameter)
        if model_param:
            creator = model_param.createdBy
    except:
        creator = None

    if not creator:
        return {
            'name': '',
            'type': '',
            'timelineIndex': None,
        }

    return {
        'name': _safe_get(creator, 'name', '') or '',
        'type': _short_type(creator),
        'timelineIndex': _timeline_index(creator),
    }


def _parameter_component(parameter):
    try:
        model_param = adsk.fusion.ModelParameter.cast(parameter)
        if model_param and model_param.component:
            return model_param.component.name
    except:
        pass
    return ''


def _extract_parameters(design):
    result = []
    parameters = design.allParameters

    for index in range(parameters.count):
        parameter = parameters.item(index)
        creator = _creator_info(parameter)

        kind = 'parameter'
        if adsk.fusion.ModelParameter.cast(parameter):
            kind = 'model'
        elif adsk.fusion.UserParameter.cast(parameter):
            kind = 'user'

        value = None
        try:
            value = parameter.value
        except:
            pass

        role = ''
        try:
            model_param = adsk.fusion.ModelParameter.cast(parameter)
            if model_param:
                role = model_param.role or ''
        except:
            pass

        result.append({
            'name': _safe_get(parameter, 'name', '') or '',
            'kind': kind,
            'component': _parameter_component(parameter),
            'role': role,
            'expression': _safe_get(parameter, 'expression', '') or '',
            'unit': _safe_get(parameter, 'unit', '') or '',
            'valueInternal': value,
            'creator': creator,
        })

    return result


def _extract_sketches(component):
    result = []
    sketches = component.sketches

    for index in range(sketches.count):
        sketch = sketches.item(index)
        dimensions = []

        try:
            sketch_dims = sketch.sketchDimensions
            for dim_index in range(sketch_dims.count):
                dim = sketch_dims.item(dim_index)
                param = _safe_get(dim, 'parameter')
                if param:
                    dimensions.append({
                        'parameter': _safe_get(param, 'name', '') or '',
                        'expression': _safe_get(param, 'expression', '') or '',
                        'unit': _safe_get(param, 'unit', '') or '',
                        'dimensionType': _short_type(dim),
                    })
        except:
            pass

        profile_count = None
        try:
            profile_count = sketch.profiles.count
        except:
            pass

        result.append({
            'name': sketch.name,
            'timelineIndex': _timeline_index(sketch),
            'isVisible': _safe_get(sketch, 'isVisible'),
            'profileCount': profile_count,
            'dimensions': dimensions,
        })

    return result


def _extract_features(component):
    result = []
    features = component.features

    for index in range(features.count):
        feature = features.item(index)

        suppressed = None
        try:
            suppressed = feature.isSuppressed
        except:
            pass

        health_state = None
        health_message = ''
        try:
            timeline_obj = feature.timelineObject
            if timeline_obj:
                health_state = int(timeline_obj.healthState)
                health_message = timeline_obj.errorOrWarningMessage or ''
        except:
            pass

        result.append({
            'name': feature.name,
            'type': _short_type(feature),
            'timelineIndex': _timeline_index(feature),
            'operation': _feature_operation_name(feature),
            'isSuppressed': suppressed,
            'healthState': health_state,
            'healthMessage': health_message,
        })

    return result


def _extract_bodies(component):
    result = []
    bodies = component.bRepBodies

    for index in range(bodies.count):
        body = bodies.item(index)
        volume = None
        try:
            volume = body.volume
        except:
            pass

        result.append({
            'name': body.name,
            'isSolid': _safe_get(body, 'isSolid'),
            'volumeInternal': volume,
        })

    return result


def _extract_occurrences(root_component):
    result = []
    try:
        occurrences = root_component.allOccurrences
        for index in range(occurrences.count):
            occ = occurrences.item(index)
            result.append({
                'name': occ.name,
                'fullPathName': _safe_get(occ, 'fullPathName', '') or '',
                'component': occ.component.name if occ.component else '',
                'isVisible': _safe_get(occ, 'isLightBulbOn'),
            })
    except:
        pass
    return result


def build_snapshot():
    global APP

    doc = APP.activeDocument
    design = adsk.fusion.Design.cast(APP.activeProduct)
    if not doc or not design:
        return None

    default_length_units = ''
    try:
        default_length_units = design.unitsManager.defaultLengthUnits
    except:
        pass

    document_info = {
        'name': doc.name,
        'key': _document_key(doc),
        'timestamp': _now_iso(),
        'defaultLengthUnits': default_length_units,
    }

    try:
        if doc.dataFile:
            document_info['dataFileId'] = doc.dataFile.id
            document_info['versionId'] = _safe_get(doc.dataFile, 'versionId', '') or ''
    except:
        pass

    components = []
    all_components = design.allComponents
    for index in range(all_components.count):
        component = all_components.item(index)
        components.append({
            'name': component.name,
            'index': index,
            'features': _extract_features(component),
            'sketches': _extract_sketches(component),
            'bodies': _extract_bodies(component),
        })

    return {
        'schemaVersion': 1,
        'source': 'Autodesk Fusion',
        'document': document_info,
        'components': components,
        'occurrences': _extract_occurrences(design.rootComponent),
        'parameters': _extract_parameters(design),
    }


def _feature_map(snapshot):
    result = {}
    for component in snapshot.get('components', []):
        component_name = component.get('name', '')
        for feature in component.get('features', []):
            # Timeline position + type is a practical identity for this MVP and
            # lets us detect renames without relying on mutable display names.
            key = (
                component_name,
                feature.get('timelineIndex'),
                feature.get('type', ''),
            )
            result[key] = feature
    return result


def _sketch_map(snapshot):
    result = {}
    for component in snapshot.get('components', []):
        component_name = component.get('name', '')
        for sketch in component.get('sketches', []):
            key = (component_name, sketch.get('timelineIndex'))
            result[key] = sketch
    return result


def _parameter_map(snapshot):
    # Fusion parameter names (d0, d1, user parameter names, etc.) are the most
    # reliable practical key across two immediate snapshots in the same design.
    result = {}
    for parameter in snapshot.get('parameters', []):
        key = parameter.get('name', '')
        if key:
            result[key] = parameter
    return result


def diff_snapshots(before, after):
    changes = {
        'addedFeatures': [],
        'removedFeatures': [],
        'renamedFeatures': [],
        'suppressionChanges': [],
        'operationChanges': [],
        'addedSketches': [],
        'removedSketches': [],
        'renamedSketches': [],
        'changedParameters': [],
        'addedParameters': [],
        'removedParameters': [],
    }

    before_features = _feature_map(before)
    after_features = _feature_map(after)

    for key, feature in after_features.items():
        if key not in before_features:
            changes['addedFeatures'].append({
                'component': key[0],
                **feature,
            })
        else:
            old = before_features[key]
            if old.get('name') != feature.get('name'):
                changes['renamedFeatures'].append({
                    'component': key[0],
                    'type': feature.get('type', ''),
                    'timelineIndex': feature.get('timelineIndex'),
                    'before': old.get('name', ''),
                    'after': feature.get('name', ''),
                })
            if old.get('isSuppressed') != feature.get('isSuppressed'):
                changes['suppressionChanges'].append({
                    'component': key[0],
                    'feature': feature.get('name', ''),
                    'type': feature.get('type', ''),
                    'timelineIndex': feature.get('timelineIndex'),
                    'before': old.get('isSuppressed'),
                    'after': feature.get('isSuppressed'),
                })
            if old.get('operation', '') != feature.get('operation', ''):
                changes['operationChanges'].append({
                    'component': key[0],
                    'feature': feature.get('name', ''),
                    'type': feature.get('type', ''),
                    'timelineIndex': feature.get('timelineIndex'),
                    'before': old.get('operation', ''),
                    'after': feature.get('operation', ''),
                })

    for key, feature in before_features.items():
        if key not in after_features:
            changes['removedFeatures'].append({
                'component': key[0],
                **feature,
            })

    before_sketches = _sketch_map(before)
    after_sketches = _sketch_map(after)

    for key, sketch in after_sketches.items():
        if key not in before_sketches:
            changes['addedSketches'].append({
                'component': key[0],
                **sketch,
            })
        else:
            old = before_sketches[key]
            if old.get('name') != sketch.get('name'):
                changes['renamedSketches'].append({
                    'component': key[0],
                    'timelineIndex': sketch.get('timelineIndex'),
                    'before': old.get('name', ''),
                    'after': sketch.get('name', ''),
                })

    for key, sketch in before_sketches.items():
        if key not in after_sketches:
            changes['removedSketches'].append({
                'component': key[0],
                **sketch,
            })

    before_params = _parameter_map(before)
    after_params = _parameter_map(after)

    for name, parameter in after_params.items():
        if name not in before_params:
            changes['addedParameters'].append(parameter)
            continue

        old = before_params[name]
        if old.get('expression') != parameter.get('expression'):
            changes['changedParameters'].append({
                'name': name,
                'kind': parameter.get('kind', ''),
                'component': parameter.get('component', ''),
                'role': parameter.get('role', ''),
                'creator': parameter.get('creator', {}),
                'before': old.get('expression', ''),
                'after': parameter.get('expression', ''),
                'unit': parameter.get('unit', ''),
                'valueBeforeInternal': old.get('valueInternal'),
                'valueAfterInternal': parameter.get('valueInternal'),
            })

    for name, parameter in before_params.items():
        if name not in after_params:
            changes['removedParameters'].append(parameter)

    return changes


def _count_changes(changes):
    return sum(len(items) for items in changes.values())


def _creator_key(component, creator):
    creator = creator or {}
    return (
        component or '',
        creator.get('timelineIndex'),
        creator.get('type', '') or '',
        creator.get('name', '') or '',
    )


def _feature_event_key(component, feature):
    return (
        component or '',
        feature.get('timelineIndex'),
        feature.get('type', '') or '',
        feature.get('name', '') or '',
    )


def _property_name(parameter):
    return parameter.get('role') or parameter.get('name') or 'value'


def normalize_changes(changes):
    """Collapse Fusion's low-level feature + parameter changes into engineering actions.

    Raw Fusion data is intentionally retained in event['changes']; this normalized list
    is for humans, the timeline UI, and later LLM input.
    """
    events = {}
    order = []

    def ensure_feature_event(key, component, feature_name, feature_type, timeline_index, action='feature_modified'):
        if key not in events:
            events[key] = {
                'action': action,
                'component': component or '',
                'feature': {
                    'name': feature_name or '',
                    'type': feature_type or '',
                    'kind': _feature_kind(feature_type or ''),
                    'timelineIndex': timeline_index,
                },
                'properties': [],
            }
            order.append(key)
        elif action in ('feature_added', 'feature_removed'):
            # Addition/removal is more specific than a generic modification.
            events[key]['action'] = action
        return events[key]

    added_keys = set()
    removed_keys = set()

    for feature in changes.get('addedFeatures', []):
        key = _feature_event_key(feature.get('component', ''), feature)
        added_keys.add(key)
        event = ensure_feature_event(
            key,
            feature.get('component', ''),
            feature.get('name', ''),
            feature.get('type', ''),
            feature.get('timelineIndex'),
            'feature_added',
        )
        operation = feature.get('operation', '')
        if operation:
            event['feature']['operation'] = operation

    for feature in changes.get('removedFeatures', []):
        key = _feature_event_key(feature.get('component', ''), feature)
        removed_keys.add(key)
        event = ensure_feature_event(
            key,
            feature.get('component', ''),
            feature.get('name', ''),
            feature.get('type', ''),
            feature.get('timelineIndex'),
            'feature_removed',
        )
        operation = feature.get('operation', '')
        if operation:
            event['feature']['operation'] = operation

    def key_from_named_change(item):
        return (
            item.get('component', ''),
            item.get('timelineIndex'),
            item.get('type', '') or '',
            item.get('feature', '') or item.get('after', '') or item.get('before', ''),
        )

    for item in changes.get('renamedFeatures', []):
        key = (
            item.get('component', ''), item.get('timelineIndex'), item.get('type', ''), item.get('after', '')
        )
        event = ensure_feature_event(
            key, item.get('component', ''), item.get('after', ''), item.get('type', ''), item.get('timelineIndex')
        )
        event['rename'] = {'before': item.get('before', ''), 'after': item.get('after', '')}

    for item in changes.get('suppressionChanges', []):
        key = key_from_named_change(item)
        event = ensure_feature_event(
            key, item.get('component', ''), item.get('feature', ''), item.get('type', ''), item.get('timelineIndex')
        )
        event['suppression'] = {'before': item.get('before'), 'after': item.get('after')}

    for item in changes.get('operationChanges', []):
        key = key_from_named_change(item)
        event = ensure_feature_event(
            key, item.get('component', ''), item.get('feature', ''), item.get('type', ''), item.get('timelineIndex')
        )
        event['operation'] = {'before': item.get('before', ''), 'after': item.get('after', '')}

    # Parameters created with a feature (e.g. Extrude distance + taper, Hole depth
    # + diameter + tip angle) are properties of the same engineering action.
    for parameter in changes.get('addedParameters', []):
        creator = parameter.get('creator') or {}
        key = _creator_key(parameter.get('component', ''), creator)
        # Match added feature keys even when name changes are irrelevant.
        matching = next((k for k in added_keys if k[:3] == key[:3]), None)
        if matching:
            event = events[matching]
        else:
            event = ensure_feature_event(
                key,
                parameter.get('component', ''),
                creator.get('name', ''),
                creator.get('type', ''),
                creator.get('timelineIndex'),
            )
        event['properties'].append({
            'name': _property_name(parameter),
            'parameter': parameter.get('name', ''),
            'value': parameter.get('expression', ''),
            'unit': parameter.get('unit', ''),
            'change': 'added',
        })

    for parameter in changes.get('removedParameters', []):
        creator = parameter.get('creator') or {}
        key = _creator_key(parameter.get('component', ''), creator)
        matching = next((k for k in removed_keys if k[:3] == key[:3]), None)
        if matching:
            event = events[matching]
        else:
            event = ensure_feature_event(
                key,
                parameter.get('component', ''),
                creator.get('name', ''),
                creator.get('type', ''),
                creator.get('timelineIndex'),
            )
        event['properties'].append({
            'name': _property_name(parameter),
            'parameter': parameter.get('name', ''),
            'value': parameter.get('expression', ''),
            'unit': parameter.get('unit', ''),
            'change': 'removed',
        })

    for parameter in changes.get('changedParameters', []):
        creator = parameter.get('creator') or {}
        key = _creator_key(parameter.get('component', ''), creator)
        event = ensure_feature_event(
            key,
            parameter.get('component', ''),
            creator.get('name', '') or parameter.get('component', ''),
            creator.get('type', ''),
            creator.get('timelineIndex'),
        )
        event['properties'].append({
            'name': _property_name(parameter),
            'parameter': parameter.get('name', ''),
            'before': parameter.get('before', ''),
            'after': parameter.get('after', ''),
            'unit': parameter.get('unit', ''),
            'change': 'modified',
        })

    # Sketch operations stay as their own engineering actions.
    sketch_events = {}
    sketch_order = []

    def add_sketch_event(key, value):
        if key not in sketch_events:
            sketch_events[key] = value
            sketch_order.append(key)
        else:
            sketch_events[key].update(value)

    for sketch in changes.get('addedSketches', []):
        key = (sketch.get('component', ''), sketch.get('timelineIndex'))
        add_sketch_event(key, {
            'action': 'sketch_added',
            'component': sketch.get('component', ''),
            'sketch': {'name': sketch.get('name', ''), 'timelineIndex': sketch.get('timelineIndex')},
        })

    for sketch in changes.get('removedSketches', []):
        key = (sketch.get('component', ''), sketch.get('timelineIndex'))
        add_sketch_event(key, {
            'action': 'sketch_removed',
            'component': sketch.get('component', ''),
            'sketch': {'name': sketch.get('name', ''), 'timelineIndex': sketch.get('timelineIndex')},
        })

    for sketch in changes.get('renamedSketches', []):
        key = (sketch.get('component', ''), sketch.get('timelineIndex'))
        add_sketch_event(key, {
            'action': sketch_events.get(key, {}).get('action', 'sketch_modified'),
            'component': sketch.get('component', ''),
            'sketch': {'name': sketch.get('after', ''), 'timelineIndex': sketch.get('timelineIndex')},
            'rename': {'before': sketch.get('before', ''), 'after': sketch.get('after', '')},
        })

    normalized = [events[key] for key in order]
    normalized.extend(sketch_events[key] for key in sketch_order)
    return normalized


def _meaningful_properties(properties):
    """Hide low-value defaults from the rationale prompt while preserving them in JSON."""
    visible = []
    for prop in properties:
        name = prop.get('name', '')
        value = prop.get('value', '')
        if name == 'TangencyWeight' and value in ('1', '1.0', '1.00'):
            continue
        if name == 'TaperAngle' and value in ('0 deg', '0.0 deg', '0.00 deg'):
            continue
        visible.append(prop)
    return visible


def _human_change_summary(engineering_changes, max_lines=8):
    lines = []

    for change in engineering_changes:
        action = change.get('action', '')
        feature = change.get('feature') or {}
        feature_name = feature.get('name') or change.get('component') or 'Feature'
        kind = feature.get('kind') or feature.get('type') or 'feature'

        if action == 'feature_added':
            line = f"Added {feature_name} ({kind})"
            operation = feature.get('operation', '')
            if operation:
                line += f" [{operation}]"
            lines.append(line)
        elif action == 'feature_removed':
            lines.append(f"Removed {feature_name} ({kind})")
        elif action == 'feature_modified':
            lines.append(f"Modified {feature_name}")
        elif action == 'sketch_added':
            lines.append(f"Added sketch: {(change.get('sketch') or {}).get('name', '')}")
        elif action == 'sketch_removed':
            lines.append(f"Removed sketch: {(change.get('sketch') or {}).get('name', '')}")
        elif action == 'sketch_modified':
            rename = change.get('rename') or {}
            if rename:
                lines.append(f"Renamed sketch: {rename.get('before', '')} -> {rename.get('after', '')}")
            else:
                lines.append(f"Modified sketch: {(change.get('sketch') or {}).get('name', '')}")

        for prop in _meaningful_properties(change.get('properties', [])):
            if prop.get('change') == 'modified':
                lines.append(f"  {prop.get('name', '')}: {prop.get('before', '')} -> {prop.get('after', '')}")
            elif prop.get('change') == 'added':
                lines.append(f"  {prop.get('name', '')}: {prop.get('value', '')}")
            elif prop.get('change') == 'removed':
                lines.append(f"  removed {prop.get('name', '')}: {prop.get('value', '')}")

        rename = change.get('rename') or {}
        if rename and action not in ('sketch_modified',):
            lines.append(f"  renamed: {rename.get('before', '')} -> {rename.get('after', '')}")

        operation_change = change.get('operation') or {}
        if operation_change:
            lines.append(f"  operation: {operation_change.get('before', '')} -> {operation_change.get('after', '')}")

        suppression = change.get('suppression') or {}
        if suppression:
            lines.append(f"  suppressed: {suppression.get('before')} -> {suppression.get('after')}")

    if not lines:
        return 'Structured CAD change detected.'

    visible = lines[:max_lines]
    if len(lines) > max_lines:
        visible.append(f"...and {len(lines) - max_lines} more detail line(s)")
    return '\n'.join(visible)


def _ask_for_rationale(engineering_changes):
    summary = _human_change_summary(engineering_changes)
    prompt = (
        'Detected engineering changes:\n\n'
        + summary
        + '\n\nWhy did you make this change?\n'
          'Enter a short engineering rationale.'
    )

    try:
        result = UI.inputBox(prompt, 'Design Recorder - Rationale', '')
        if not result:
            return None, True

        rationale = result[0] if len(result) > 0 else ''
        cancelled = bool(result[1]) if len(result) > 1 else False

        if cancelled:
            return None, True

        return (rationale or '').strip(), False
    except:
        APP.log('Design Recorder rationale prompt failed:\n' + traceback.format_exc())
        return '', False


def _capture_viewport(path):
    try:
        options = adsk.core.SaveImageFileOptions.create(path)
        options.width = 1600
        options.height = 900
        options.isAntiAliased = True
        return bool(APP.activeViewport.saveAsImageFileWithOptions(options))
    except:
        APP.log('Design Recorder viewport capture failed:\n' + traceback.format_exc())
        return False


def _save_fusion_document():
    doc = APP.activeDocument
    if not doc:
        return {'ok': False, 'message': 'No active Fusion document.'}

    try:
        ok = bool(doc.save('Design Recorder checkpoint'))
        if ok:
            return {'ok': True, 'message': 'Fusion document saved.'}
        return {'ok': False, 'message': 'Fusion returned false while saving.'}
    except:
        return {
            'ok': False,
            'message': 'Fusion save failed. If this file has never been saved, save it once manually first.',
            'details': traceback.format_exc(),
        }


def _write_baseline(snapshot):
    doc_name = _safe_filename(snapshot['document']['name'])
    baseline_dir = os.path.join(OUTPUT_ROOT, doc_name, 'state')
    _json_dump(snapshot, os.path.join(baseline_dir, 'baseline.json'))


def _record_checkpoint():
    global LAST_SNAPSHOT, LAST_DOCUMENT_KEY

    current = build_snapshot()
    if not current:
        UI.messageBox('Design Recorder needs an active Fusion Design document.')
        return

    current_doc_key = current['document']['key']

    # If the user switched documents, start a clean baseline rather than diffing
    # unrelated models.
    if LAST_SNAPSHOT is None or LAST_DOCUMENT_KEY != current_doc_key:
        LAST_SNAPSHOT = current
        LAST_DOCUMENT_KEY = current_doc_key
        _write_baseline(current)
        save_result = _save_fusion_document()
        UI.messageBox(
            'Design Recorder baseline initialized for:\n\n'
            + current['document']['name']
            + '\n\nMake a change and use Record Design Change again.'
            + ('\n\nThe Fusion document was saved.' if save_result['ok'] else '\n\n' + save_result['message'])
        )
        return

    changes = diff_snapshots(LAST_SNAPSHOT, current)
    raw_change_count = _count_changes(changes)
    engineering_changes = normalize_changes(changes)
    change_count = len(engineering_changes)

    if raw_change_count == 0:
        UI.messageBox(
            'No structured CAD changes were detected since the previous checkpoint.\n\n'
            'Nothing was recorded.',
            'Design Recorder'
        )
        return

    rationale, cancelled = _ask_for_rationale(engineering_changes)
    if cancelled:
        UI.messageBox(
            'Checkpoint cancelled. No event was recorded and the previous baseline was kept.',
            'Design Recorder'
        )
        return

    doc_name = _safe_filename(current['document']['name'])
    stamp = _timestamp_for_file()
    event_dir = os.path.join(OUTPUT_ROOT, doc_name, 'events', stamp)
    os.makedirs(event_dir, exist_ok=True)

    image_path = os.path.join(event_dir, 'viewport.png')
    image_ok = _capture_viewport(image_path)

    # The checkpoint also saves the actual Fusion cloud document. This runs from
    # a queued custom event, not a Command event, because Fusion does not allow
    # Document.save inside a command transaction.
    save_result = _save_fusion_document()

    event = {
        'id': str(uuid.uuid4()),
        'schemaVersion': 2,
        'eventType': 'design_checkpoint',
        'timestamp': _now_iso(),
        'source': 'Autodesk Fusion',
        'document': current['document'],
        'changeCount': change_count,
        'rawChangeCount': raw_change_count,
        'engineeringChanges': engineering_changes,
        'changes': changes,
        'rationale': rationale,
        'viewport': {
            'captured': image_ok,
            'path': image_path if image_ok else '',
        },
        'fusionSave': save_result,
    }

    _json_dump(LAST_SNAPSHOT, os.path.join(event_dir, 'before_snapshot.json'))
    _json_dump(current, os.path.join(event_dir, 'after_snapshot.json'))

    # Write locally first. Remote connectivity must never make the checkpoint
    # disappear from the engineer's machine.
    event_path = os.path.join(event_dir, 'event.json')
    latest_event_path = os.path.join(OUTPUT_ROOT, 'latest_event.json')
    _json_dump(event, event_path)
    _json_dump(event, latest_event_path)

    upload_result = _upload_event(event, image_path if image_ok else '', event_path)

    LAST_SNAPSHOT = current
    LAST_DOCUMENT_KEY = current_doc_key
    _write_baseline(current)

    APP.log('Design Recorder event:\n' + json.dumps(event, indent=2))

    summary = f'Recorded {change_count} engineering change(s).'
    if rationale:
        summary += '\nRationale saved.'
    else:
        summary += '\nRationale left blank.'
    if image_ok:
        summary += '\nViewport image captured.'
    if save_result['ok']:
        summary += '\nFusion document saved.'
    else:
        summary += '\n\nWARNING: ' + save_result['message']

    summary += '\n' + upload_result.get('message', 'Checkpoint saved locally.')

    summary += '\n\nOutput:\n' + event_dir

    UI.messageBox(summary, 'Design Recorder')


class _RecordExecuteHandler(adsk.core.CommandEventHandler):
    def __init__(self):
        super().__init__()

    def notify(self, args):
        try:
            # Queue the work until Fusion is idle. This is essential because
            # Fusion does not allow a document save while a Command event is
            # running.
            APP.fireCustomEvent(CUSTOM_EVENT_ID, '')
        except:
            if UI:
                UI.messageBox('Could not queue Design Recorder checkpoint:\n\n' + traceback.format_exc())


class _RecordCommandCreatedHandler(adsk.core.CommandCreatedEventHandler):
    def __init__(self):
        super().__init__()

    def notify(self, args):
        try:
            event_args = adsk.core.CommandCreatedEventArgs.cast(args)
            command = event_args.command
            handler = _RecordExecuteHandler()
            command.execute.add(handler)
            HANDLERS.append(handler)
        except:
            if UI:
                UI.messageBox('Design Recorder command failed:\n\n' + traceback.format_exc())


class _QueuedCheckpointHandler(adsk.core.CustomEventHandler):
    def __init__(self):
        super().__init__()
        self.recording = False

    def notify(self, args):
        if self.recording:
            return
        self.recording = True
        try:
            event_args = adsk.core.CustomEventArgs.cast(args)
            info = event_args.additionalInfo
            if info:
                request = json.loads(info)
                if (not SHORTCUT_LISTENER or
                        not SHORTCUT_LISTENER.can_dispatch(request, UI.activeCommand)):
                    APP.log('Trace shortcut ignored: keep Fusion active and finish the current command before recording.')
                    return
            # Fusion's own API examples use SelectCommand to terminate any active
            # command before performing queued work on the main thread.
            if UI.activeCommand != 'SelectCommand':
                select_def = UI.commandDefinitions.itemById('SelectCommand')
                if select_def:
                    select_def.execute()
            _record_checkpoint()
        except:
            if UI:
                UI.messageBox('Design Recorder checkpoint failed:\n\n' + traceback.format_exc())
        finally:
            self.recording = False


def _remove_ui():
    try:
        panel = UI.allToolbarPanels.itemById(PANEL_ID)
        if panel:
            control = panel.controls.itemById(COMMAND_ID)
            if control:
                control.deleteMe()
    except:
        pass

    try:
        command_def = UI.commandDefinitions.itemById(COMMAND_ID)
        if command_def and not command_def.isNative:
            command_def.deleteMe()
    except:
        pass


def run(context):
    global APP, UI, CUSTOM_EVENT, LAST_SNAPSHOT, LAST_DOCUMENT_KEY, TRANSPORT, SHORTCUT_LISTENER

    try:
        APP = adsk.core.Application.get()
        UI = APP.userInterface
        os.makedirs(OUTPUT_ROOT, exist_ok=True)
        spec = importlib.util.spec_from_file_location('trace_fusion_transport', os.path.join(ADDIN_DIR, 'trace_transport.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        if TRANSPORT:
            TRANSPORT.stop()
        if SHORTCUT_LISTENER:
            SHORTCUT_LISTENER.stop()
            SHORTCUT_LISTENER = None
        TRANSPORT = module.Transport()
        if _load_config().get('uploadEnabled', True):
            TRANSPORT.start()

        # Clear stale UI from a previous failed/debug run.
        _remove_ui()

        # Clear stale custom-event registration if one exists.
        try:
            APP.unregisterCustomEvent(CUSTOM_EVENT_ID)
        except:
            pass

        CUSTOM_EVENT = APP.registerCustomEvent(CUSTOM_EVENT_ID)
        queued_handler = _QueuedCheckpointHandler()
        CUSTOM_EVENT.add(queued_handler)
        HANDLERS.append(queued_handler)

        command_def = UI.commandDefinitions.addButtonDefinition(
            COMMAND_ID,
            COMMAND_NAME,
            COMMAND_TOOLTIP,
        )
        created_handler = _RecordCommandCreatedHandler()
        command_def.commandCreated.add(created_handler)
        HANDLERS.append(created_handler)

        panel = UI.allToolbarPanels.itemById(PANEL_ID)
        if not panel:
            raise RuntimeError('Could not find Fusion Add-Ins toolbar panel: ' + PANEL_ID)

        control = panel.controls.addCommand(command_def)
        control.isPromotedByDefault = True
        control.isPromoted = True

        # Capture a baseline immediately so the first hotkey records changes made
        # after the add-in starts.
        LAST_SNAPSHOT = build_snapshot()
        if LAST_SNAPSHOT:
            LAST_DOCUMENT_KEY = LAST_SNAPSHOT['document']['key']
            _write_baseline(LAST_SNAPSHOT)

        SHORTCUT_LISTENER = module.CheckpointShortcuts(
            lambda request: APP.fireCustomEvent(CUSTOM_EVENT_ID, json.dumps(request)))
        SHORTCUT_LISTENER.start()
        APP.log('Design Recorder v0.6 ready. Ctrl+Alt+S records a checkpoint while Trace is running and Fusion is active. Pending checkpoints retry in the background.')

    except:
        if TRANSPORT:
            TRANSPORT.stop()
        if SHORTCUT_LISTENER:
            SHORTCUT_LISTENER.stop()
        if UI:
            UI.messageBox('Design Recorder failed to start:\n\n' + traceback.format_exc())


def stop(context):
    global CUSTOM_EVENT, HANDLERS, LAST_SNAPSHOT, LAST_DOCUMENT_KEY, TRANSPORT, SHORTCUT_LISTENER

    try:
        if SHORTCUT_LISTENER:
            SHORTCUT_LISTENER.stop()
            SHORTCUT_LISTENER = None
        if TRANSPORT:
            TRANSPORT.stop()
            TRANSPORT = None
        _remove_ui()

        if CUSTOM_EVENT and HANDLERS:
            try:
                CUSTOM_EVENT.remove(HANDLERS[0])
            except:
                pass

        try:
            APP.unregisterCustomEvent(CUSTOM_EVENT_ID)
        except:
            pass

        CUSTOM_EVENT = None
        HANDLERS = []
        LAST_SNAPSHOT = None
        LAST_DOCUMENT_KEY = None

        if APP:
            APP.log('Design Recorder Agent stopped.')

    except:
        if UI:
            UI.messageBox('Design Recorder failed to stop cleanly:\n\n' + traceback.format_exc())
