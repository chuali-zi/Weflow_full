"""Read the member records in chat_room.ext_buffer (protobuf wire format)."""


def fields(data):
    position = 0

    def varint():
        nonlocal position
        value = 0
        for shift in range(0, 70, 7):
            if position >= len(data):
                raise ValueError("truncated protobuf")
            byte = data[position]
            position += 1
            value |= (byte & 127) << shift
            if byte < 128:
                return value
        raise ValueError("invalid varint")

    while position < len(data):
        tag = varint()
        number, wire = tag >> 3, tag & 7
        if number == 0:
            raise ValueError("invalid field")
        if wire == 0:
            value = varint()
        elif wire in (1, 2, 5):
            size = varint() if wire == 2 else 8 if wire == 1 else 4
            end = position + size
            if end > len(data):
                raise ValueError("truncated field")
            value = data[position:end]
            position = end
        else:
            raise ValueError("unsupported wire type")
        yield number, wire, value


def group_nicknames(buffer):
    """Absence of field 2 means unset; a missing/bad record stays unknown."""
    if not isinstance(buffer, bytes) or not buffer:
        return {}
    result = {}
    try:
        for number, wire, value in fields(buffer):
            if (number, wire) != (1, 2):
                continue
            username, nickname = None, ""
            for field, kind, content in fields(value):
                if field in (1, 2):
                    if kind != 2:
                        raise ValueError("invalid member text field")
                    text = content.decode("utf-8", errors="strict")
                    if field == 1:
                        username = text
                    else:
                        nickname = text
            if not username or username in result:
                raise ValueError("missing or duplicate member identity")
            result[username] = nickname
    except (ValueError, UnicodeDecodeError):
        # Do not turn an incomplete decode into false 'not set' results.
        return {}
    return result
