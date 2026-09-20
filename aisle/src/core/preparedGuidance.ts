/** Finite, deterministic indoor vocabulary, generated into bundled ElevenLabs clips. */
import { integerToWords } from '../outdoor/numberWords';

export type PreparedGuideKind = 'arrived' | 'forward' | 'sidestep' | 'turn_little' | 'turn' | 'turn_around' | 'scan_remembered' | 'scan_unknown';
export type PreparedKey = `guide_${string}` | `mission_${string}`;

export function guidanceText(kind: PreparedGuideKind, name: string, steps: number | null, side: string): string {
  const n = name[0]!.toUpperCase() + name.slice(1);
  const distance = steps === null ? 'a few steps' : steps <= 1 ? 'one step' : `${integerToWords(steps)} steps`;
  switch (kind) {
    case 'arrived': return `${n} close ahead. Stop here.`;
    case 'forward': return `${n} ahead, about ${distance}. Walk slowly forward.`;
    case 'sidestep': return `Obstacle ahead. Stop and check with your cane.`;
    case 'turn_little': return `${n} ahead to your ${side}. Turn ${side} a little.`;
    case 'turn': return `Turn ${side} to face the ${name}.`;
    case 'turn_around': return `${n} behind you. Turn slowly around.`;
    case 'scan_remembered': return `Stay still. Turn the camera ${side} to find the ${name}.`;
    case 'scan_unknown': return `${n} not visible. Stay still and scan slowly.`;
  }
}

export const MISSION_PHRASES = {
  mission_search_next: 'Task complete. Search for another item, or tell me your new environment.',
  mission_search_processing: 'Hold the camera steady while I process this view.',
  mission_search_verify: 'Checking a possible match. Hold the camera steady.',
  mission_search_auto: 'I will explore a new direction now. Say stop anytime.',
  mission_search_auto_aisle: 'I will guide you toward another aisle. Say stop anytime.',
  mission_search_auto_retrace: 'I will retrace our route to another place. Say stop anytime.',
  mission_search_wait: 'Staying here. Say explore when you want to move.',
  mission_search_retry_camera: 'Waiting for camera analysis. Hold steady; I am retrying.',
  mission_search_tracking: 'Stop. Hold the phone steady while I recover our position.',
  mission_search_path: 'Hold still while I check the path ahead.',
  mission_search_position: 'Stop. Hold still while I recover our position.',
  mission_search_resume: 'Resuming the search. Hold the camera steady.',
  mission_search_opening: 'Turn slowly so I can find another opening.',
  mission_search_inspect: 'This area looks promising. Let me inspect it more closely.',
  mission_search_shelves: 'This section looks promising. Let me search these shelves closely.',
  mission_search_stop: 'Stop here. Let me look around again.',
  mission_search_recheck: 'Stop here. Let me check this area again.',
  mission_search_stalled: 'Stop. This route is stalled. Let me find another way.',
  mission_search_sign: 'Sign nearby. Hold still while I locate the actual display.',
  mission_search_timeout: 'That took too long. Let me look for another way.',
  mission_search_view: 'Hold the camera steady. I need a current view.',
  mission_search_dark: 'The view is dark. Aim toward a brighter area.',
  mission_search_blur: 'The view is blocked or blurred. Hold the camera steady.',
  mission_search_consent: 'Please say yes to move, or no to stay.',
  mission_search_stay: 'We will stay here and inspect another angle.',
  mission_search_upper: 'Pan slowly across the upper shelf.',
  mission_search_middle: 'Now pan across the middle shelf.',
  mission_search_lower: 'Tilt down and scan the lower shelf.',
  mission_fridge_approach: 'First, find the fridge. Then open it and find your item.',
  mission_fridge_open: 'Stop at the fridge. Find its handle and open the door.',
  mission_fridge_find: 'Keep still. Point the camera inside the open fridge.',
  mission_fridge_reach: 'Keep the item and your outstretched hand in the camera view.',
  mission_pickup_confirm: 'Have you picked it up? Say yes when you have it.',
  mission_wait_open: 'Open the fridge, then say the door is open.',
  mission_hand_aligned: 'Hand aligned in the image. Reach slowly. Confirm when holding it.',
  mission_hand_missing: 'Show your outstretched hand and the item together.',
  mission_target_missing: 'Item not visible. Keep still and point the camera inside.',
  mission_paused: 'Still working on your request. Say repeat for the current step.',
  mission_retry: 'I lost sight of the item. Reposition the camera to retry.',
  mission_find_eggs: 'Looking for your eggs inside the fridge. Keep the camera steady.',
  mission_find_milk: 'Looking for your milk inside the fridge. Keep the camera steady.',
  mission_find_item: 'Looking for your requested item. Keep the camera steady.',
} as const;

const TARGETS = ['fridge', 'couch', 'table', 'chair', 'bed', 'sink', 'oven', 'microwave', 'door', 'cup', 'bottle', 'eggs', 'milk'];
export const PREPARED_GUIDANCE: ReadonlyArray<{ key: PreparedKey; text: string }> = [
  ...Object.entries(MISSION_PHRASES).map(([key, text]) => ({ key: key as PreparedKey, text })),
  ...TARGETS.flatMap((name) => [
    ...Array.from({ length: 20 }, (_, i) => ({ key: `guide_${name}_forward_${i + 1}` as PreparedKey, text: guidanceText('forward', name, i + 1, 'right') })),
    ...(['arrived', 'turn_around', 'scan_unknown'] as const).map((kind) => ({ key: `guide_${name}_${kind}` as PreparedKey, text: guidanceText(kind, name, null, 'right') })),
    ...(['turn_little', 'turn', 'scan_remembered'] as const).flatMap((kind) => ['left', 'right'].map((side) => ({ key: `guide_${name}_${kind}_${side}` as PreparedKey, text: guidanceText(kind, name, null, side) }))),
  ]),
  { key: 'guide_obstacle_stop', text: guidanceText('sidestep', 'target', null, 'left') },
];
