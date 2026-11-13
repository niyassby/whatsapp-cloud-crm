-- WhatsApp channels follow their phone numbers, so no code path can forget one.
-- Plain (not SECURITY DEFINER) triggers: they run as the caller, under the same RLS context, so
-- a number can only ever create a channel in its own org.

CREATE FUNCTION phone_number_channel_sync() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp
  AS $$
  BEGIN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO channels (id, org_id, kind, name, status, phone_id, created_at, updated_at)
      VALUES (gen_random_uuid(), NEW.org_id, 'whatsapp',
              COALESCE(NEW.verified_name, NEW.display_phone_number, 'WhatsApp'),
              CASE WHEN NEW.status = 'disconnected' THEN 'disconnected'::"ChannelStatus"
                   ELSE 'active'::"ChannelStatus" END,
              NEW.id, now(), now());
    ELSIF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.verified_name IS DISTINCT FROM OLD.verified_name
       OR NEW.display_phone_number IS DISTINCT FROM OLD.display_phone_number THEN
      UPDATE channels SET
        status = CASE WHEN NEW.status = 'disconnected' THEN 'disconnected'::"ChannelStatus"
                      ELSE 'active'::"ChannelStatus" END,
        disconnected_at = CASE WHEN NEW.status = 'disconnected' THEN now() ELSE NULL END,
        name = COALESCE(NEW.verified_name, NEW.display_phone_number, name),
        updated_at = now()
      WHERE phone_id = NEW.id;
    END IF;
    RETURN NEW;
  END
  $$;

CREATE TRIGGER phone_numbers_channel
  AFTER INSERT OR UPDATE ON phone_numbers
  FOR EACH ROW EXECUTE FUNCTION phone_number_channel_sync();

CREATE FUNCTION conversation_channel_default() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp
  AS $$
  BEGIN
    IF NEW.channel_id IS NULL AND NEW.phone_id IS NOT NULL THEN
      SELECT c.id INTO NEW.channel_id FROM channels c WHERE c.phone_id = NEW.phone_id;
    END IF;
    -- A WhatsApp channel's conversations always name its number, so old queries by phone work.
    IF NEW.phone_id IS NULL AND NEW.channel_id IS NOT NULL THEN
      SELECT c.phone_id INTO NEW.phone_id FROM channels c WHERE c.id = NEW.channel_id;
    END IF;
    RETURN NEW;
  END
  $$;

CREATE TRIGGER conversations_channel_default
  BEFORE INSERT ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversation_channel_default();
