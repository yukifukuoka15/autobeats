import { SerialButtonDevice } from './serial';
import type { ButtonDevice } from './types';
import { VirtualButtonDevice } from './virtual';
import type { DeviceInfo } from '../../shared/types';

export class DeviceManager {
  readonly virtual: VirtualButtonDevice;
  readonly serial = new SerialButtonDevice();
  private readonly devices: ButtonDevice[];

  constructor(now?: () => number) {
    this.virtual = new VirtualButtonDevice(now);
    this.devices = [this.virtual, this.serial];
  }

  list(): DeviceInfo[] {
    return this.devices.map((d) => ({ id: d.id, name: d.name, kind: d.kind, connected: d.connected }));
  }

  get(id: string): ButtonDevice | undefined {
    return this.devices.find((d) => d.id === id);
  }

  /** 指定デバイスを接続して返す。失敗は日本語の Error */
  async acquire(id: string): Promise<ButtonDevice> {
    const d = this.get(id);
    if (!d) throw new Error('選択したデバイスが見つかりません。');
    if (!d.connected) await d.connect();
    return d;
  }
}
