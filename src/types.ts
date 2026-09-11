export type RgbColor = {
  r: number;
  g: number;
  b: number;
};

export type ZoneSnapshot = {
  id: number;
  name: string;
  zone_type: string;
  led_count: number;
  colors: RgbColor[];
  uniform_color: RgbColor | null;
};

export type ControllerSnapshot = {
  id: number;
  name: string;
  vendor: string;
  description: string;
  version: string;
  serial: string;
  location: string;
  device_type: string;
  led_count: number;
  active_mode: string;
  zones: ZoneSnapshot[];
};

export type OpenRgbSnapshot = {
  connected: boolean;
  address: string;
  protocol_version: number;
  profiles: string[];
  controllers: ControllerSnapshot[];
};

export type SavedProfile = {
  name: string;
  captured_at_unix_ms: number;
  controllers: ControllerSnapshot[];
};

export type CaptureProfileResult = {
  profile: SavedProfile;
  snapshot: OpenRgbSnapshot;
};
